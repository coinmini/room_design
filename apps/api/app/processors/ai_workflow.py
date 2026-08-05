from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterable

import cv2
import numpy as np

from app.config import settings
from app.processors.common import ProcessorError
from app.processors.fanout import (
    CancelCheck,
    FANOUT_WORKERS,
    PROVIDER_SEMAPHORE,
    ProgressCallback,
    fanout_generate,
)
from app.processors.kuyao_image_edit import edit_floorplan_image
from app.storage import artifact_path, artifact_url


MAX_PROMPT_CHARS = 28_000
# A1/B1 的扇出实现已抽到 app.processors.fanout，供 ai_workflow 与 layout 共用。
# 这里保留原私名别名，避免改动本文件内既有调用点。
_PROVIDER_SEMAPHORE = PROVIDER_SEMAPHORE
_VARIANT_FANOUT_WORKERS = FANOUT_WORKERS
_fanout_generate = fanout_generate


COLOR_PLAN_VARIANTS = (
    "simple_2d",
    "topdown_3d",
    "watercolor",
    "material_realistic",
)
AXONOMETRIC_VARIANTS = (
    "isometric_day",
    "isometric_night",
    "alternate_angle",
)
STYLE_SCHEME_VARIANTS = (
    "modern_minimal",
    "natural_wood",
    "midcentury_vintage",
    "french_luxury",
)
TONE_SCHEME_VARIANTS = (
    "warm_gold_day",
    "neutral_dusk",
    "cool_blue_night",
)

COLOR_PLAN_DESCRIPTIONS = {
    "simple_2d": (
        "a clean professional 2D colored architectural plan with restrained flat fills, "
        "crisp black linework, subtle greenery and a white presentation background"
    ),
    "topdown_3d": (
        "a photo-realistic roofless top-down 3D floor-plan visualization, with physically "
        "plausible furniture, materials and soft daylight, while remaining close to orthographic"
    ),
    "watercolor": (
        "an elegant hand-rendered watercolor floor plan with soft washes, architectural ink "
        "outlines and readable rooms"
    ),
    "material_realistic": (
        "a realistic material color plan viewed straight down, with believable flooring, wall "
        "finishes, furniture fabrics and restrained ambient shadows"
    ),
}

AXONOMETRIC_DESCRIPTIONS = {
    "isometric_day": (
        "a complete roofless isometric cutaway dollhouse view in bright natural daytime light"
    ),
    "isometric_night": (
        "a complete roofless isometric cutaway dollhouse view at night, with warm practical "
        "interior lighting and a darker exterior context"
    ),
    "alternate_angle": (
        "a complete roofless isometric cutaway dollhouse view from the diagonally opposite "
        "corner to a conventional front-left isometric view"
    ),
}

STYLE_SCHEME_DESCRIPTIONS = {
    "modern_minimal": (
        "gallery-like modern minimalism: pure white and charcoal palette, matte black metal "
        "details, handleless flat-panel joinery, micro-cement or polished stone floors and a few "
        "sculptural minimalist furniture pieces. Cool-neutral and crisp; strictly no warm wood "
        "tones, no ornament, no mouldings"
    ),
    "natural_wood": (
        "warm Japanese japandi: pale oak floors and slatted oak wall panels, beige linen "
        "upholstery, paper pendant lamps, low relaxed furniture, soft daylight and green plants. "
        "Everything light, wooden and tactile; strictly no black metal, no marble, no glossy "
        "surfaces, no dark walls"
    ),
    "midcentury_vintage": (
        "bold mid-century vintage: dark walnut and teak cabinetry, cognac leather seating, "
        "saturated olive-green and burnt-orange accent pieces, brass hardware, geometric pendant "
        "lamps and a patterned rug. Distinctly darker and richer; strictly no pale oak, no "
        "all-white walls, no delicate mouldings"
    ),
    "french_luxury": (
        "elegant contemporary French luxury: cream walls with classical panel mouldings and "
        "ceiling cornices, herringbone parquet, marble table tops, brushed-brass fixtures, bouclé "
        "and velvet upholstery, alabaster or crystal lighting. Refined and ornate; strictly no "
        "industrial or rustic elements, no flat modern joinery"
    ),
}

TONE_SCHEME_DESCRIPTIONS = {
    "warm_gold_day": (
        "warm golden daytime color grading, soft natural sun, creamy whites, beige and gentle "
        "golden timber undertones"
    ),
    "neutral_dusk": (
        "balanced neutral dusk color grading, softly dimmed ambient daylight and practical lights, "
        "natural whites and restrained contrast"
    ),
    "cool_blue_night": (
        "cool blue nighttime color grading, controlled moonlit shadows and warm practical-light "
        "accents without changing any fixture"
    ),
}

WORKFLOW_PROMPT_VERSION = "pure-ai-design-workflow-v1"
MAX_PROMPT_ROOMS = 40
MAX_PROMPT_WALLS = 180
MAX_PROMPT_OPENINGS = 100
MAX_PROMPT_FURNITURE = 240


def _require_provider() -> None:
    if not settings.kuyao_image_edit_configured:
        raise ProcessorError(
            "AI_WORKFLOW_UNAVAILABLE",
            "未配置 gpt-image-2 图像服务，无法执行 AI 设计工作流生成",
        )


def _as_mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _semantic_layout_value(payload: dict[str, Any]) -> dict[str, Any]:
    value = _as_mapping(payload.get("semantic_layout"))
    wrapped = value.get("semanticLayout")
    if isinstance(wrapped, dict):
        value = wrapped
    elif isinstance(value.get("semantic_layout"), dict):
        value = value["semantic_layout"]
    rooms = value.get("rooms")
    return value if isinstance(rooms, list) and rooms else {}


def _existing_image(path_value: Any, label: str) -> Path:
    if not isinstance(path_value, str) or not path_value.strip():
        raise ProcessorError("INPUT_REJECTED", f"缺少{label}")
    path = Path(path_value)
    if not path.is_file():
        raise ProcessorError("INPUT_REJECTED", f"{label}不存在")
    return path


def _approved_layout_source(payload: dict[str, Any]) -> Path:
    if payload.get("layout_approved") is not True:
        raise ProcessorError(
            "LAYOUT_APPROVAL_REQUIRED",
            "只有显式确认已批准的平面布局才能进入后续 AI 设计阶段",
        )
    return _existing_image(payload.get("approved_layout_path"), "已批准平面布局图")


def _target_size(path: Path) -> str:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise ProcessorError("INPUT_REJECTED", "无法读取已批准平面布局图")
    height, width = image.shape[:2]
    ratio = width / height
    if ratio >= 1.15:
        return "1536x1024"
    if ratio <= 1 / 1.15:
        return "1024x1536"
    return "1024x1024"


def _image_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    except OSError as exc:
        raise ProcessorError("INPUT_REJECTED", "无法读取已批准平面布局图") from exc
    return digest.hexdigest()


def _compact_items(items: Any, keys: tuple[str, ...], limit: int) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    for item in _as_list(items)[:limit]:
        if not isinstance(item, dict):
            continue
        value = {key: item[key] for key in keys if key in item}
        if value:
            compact.append(value)
    return compact


def _semantic_authority(layout: dict[str, Any]) -> dict[str, Any]:
    """Keep the geometric/semantic facts useful to the image model, without prompt bloat."""

    rooms = _compact_items(
        layout.get("rooms"),
        ("id", "type", "name", "rect", "polygon"),
        MAX_PROMPT_ROOMS,
    )
    walls = _compact_items(
        layout.get("walls"),
        ("id", "kind", "start", "end", "thicknessMm", "roomIds"),
        MAX_PROMPT_WALLS,
    )
    openings = _compact_items(
        layout.get("openings"),
        (
            "id",
            "type",
            "wallId",
            "center",
            "widthMm",
            "heightMm",
            "sillHeightMm",
            "swing",
        ),
        MAX_PROMPT_OPENINGS,
    )
    furniture = _compact_items(
        layout.get("furniture"),
        ("id", "type", "roomId", "center", "size", "rotationDeg"),
        MAX_PROMPT_FURNITURE,
    )
    return {
        "version": layout.get("version"),
        "profileId": layout.get("profileId"),
        "coordinateSystem": layout.get("coordinateSystem"),
        "plan": layout.get("plan"),
        "rooms": rooms,
        "walls": walls,
        "openings": openings,
        "furniture": furniture,
    }


def _semantic_digest(layout: dict[str, Any]) -> str:
    encoded = json.dumps(
        layout,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _semantic_summary(layout: dict[str, Any]) -> dict[str, Any]:
    plan = _as_mapping(layout.get("plan"))
    rooms = _as_list(layout.get("rooms"))
    return {
        "version": layout.get("version"),
        "profileId": layout.get("profileId"),
        "sha256": _semantic_digest(layout),
        "plan": {
            key: plan.get(key)
            for key in ("widthMm", "depthMm", "ceilingHeightMm", "scaleStatus")
            if key in plan
        },
        "counts": {
            "rooms": len(rooms),
            "walls": len(_as_list(layout.get("walls"))),
            "openings": len(_as_list(layout.get("openings"))),
            "furniture": len(_as_list(layout.get("furniture"))),
        },
        "roomIds": [
            item.get("id")
            for item in rooms
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        ],
    }


def _approved_layout_summary(payload: dict[str, Any], source: Path) -> dict[str, Any]:
    return {
        "versionId": payload.get("approved_layout_version_id"),
        "assetId": payload.get("asset_parent_id"),
        "sha256": _image_sha256(source),
        "imageUrl": artifact_url(source),
        "approvalConfirmed": payload.get("layout_approved") is True,
    }


def _semantic_prompt(layout: dict[str, Any]) -> str:
    authority = _semantic_authority(layout)
    return json.dumps(authority, ensure_ascii=False, separators=(",", ":"))


def _common_geometry_lock(layout: dict[str, Any]) -> str:
    return (
        "INPUT ROLE LOCK: image 1 is the user-approved layout and the sole visual geometry "
        "authority. Preserve its complete outer contour, orientation, room count, room boundaries, "
        "walls, door and window positions, circulation, furniture categories, furniture count and "
        "furniture placement. Do not mirror, rotate, crop, stretch, merge or invent rooms. The "
        "following semanticLayout JSON is a second authoritative description; use it to resolve "
        "labels and geometry, and never contradict it:\n"
        f"{_semantic_prompt(layout)}\n"
    )


def _design_requirement(payload: dict[str, Any]) -> str:
    value = str(payload.get("design_prompt") or "").strip()
    return value or "restrained contemporary residential design with practical, buildable details"


def _reference_paths(payload: dict[str, Any], *leading: Path | None) -> list[Path]:
    paths = [item for item in leading if item is not None]
    for value in payload.get("style_reference_paths") or []:
        paths.append(_existing_image(value, "风格参考图"))
    if len(paths) > 8:
        raise ProcessorError("INPUT_REJECTED", "参考图总数不能超过 8 张")
    return paths


def _generate(
    *,
    source: Path,
    references: Iterable[Path],
    prompt: str,
    size: str,
) -> dict[str, Any]:
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ProcessorError(
            "INPUT_REJECTED",
            f"提示词超过长度限制（{MAX_PROMPT_CHARS} 字符），请简化输入后重试",
        )
    # Client-side rate limit: keeps the variant fan-out from turning an
    # occasional 429 into a systemic one.
    with _PROVIDER_SEMAPHORE:
        return edit_floorplan_image(
            source,
            api_key=settings.floorplan_vision_api_key,
            base_url=settings.kuyao_base_url,
            prompt=prompt,
            model=settings.kuyao_image_model,
            size=size,
            quality=settings.kuyao_image_quality,
            timeout_seconds=settings.kuyao_image_timeout_seconds,
            reference_paths=list(references),
        )


def _base_result(
    payload: dict[str, Any],
    *,
    stage: str,
    source: Path,
    semantic_layout: dict[str, Any],
    outputs: list[dict[str, Any]],
) -> dict[str, Any]:
    successful = [item for item in outputs if item.get("status") == "succeeded"]
    failed = [item for item in outputs if item.get("status") == "failed"]
    first = successful[0] if successful else {}
    return {
        "workflowStage": stage,
        "variantGroupId": payload["variant_group_id"],
        "generationMode": "ai_image",
        "provider": first.get("provider"),
        "model": first.get("model") or settings.kuyao_image_model,
        "promptVersion": WORKFLOW_PROMPT_VERSION,
        "approvedLayout": _approved_layout_summary(payload, source),
        "semanticInput": _semantic_summary(semantic_layout),
        "outputs": outputs,
        "count": len(outputs),
        "succeededCount": len(successful),
        "failedCount": len(failed),
        "batchStatus": "complete" if not failed else ("partial" if successful else "failed"),
        "partialOutputs": successful if failed else [],
        "approvalStatus": "review_required",
        "structureAudit": {
            "performed": False,
            "geometryGuaranteed": False,
            "requiresManualReview": True,
            "notice": "纯 AI 生成暂不提供几何一致性自动证明，必须人工核对。",
        },
        "isConceptOnly": True,
        "constructionReady": False,
        "requiresUserConfirmation": True,
        "notice": (
            "结果由 AI 基于已批准布局图与 semanticLayout 生成；应在进入下一阶段前人工确认。"
        ),
    }


def _failed_output(
    *,
    variant_id: str,
    variant_group_id: str,
    error: ProcessorError,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "variantId": variant_id,
        "variantGroupId": variant_group_id,
        "status": "failed",
        "errorCode": error.code,
        "errorMessage": error.message,
        **(extra or {}),
    }


def _raise_if_batch_failed(result: dict[str, Any], label: str) -> None:
    if result["succeededCount"]:
        return
    outputs = result.get("outputs") or []
    first = outputs[0] if outputs and isinstance(outputs[0], dict) else {}
    reason = first.get("errorMessage") or "未知错误"
    raise ProcessorError(
        "AI_WORKFLOW_BATCH_FAILED",
        f"{label}批量生成全部失败：{reason}",
        partial_result=result,
    )


def run_ai_color_plan(
    payload: dict[str, Any],
    on_progress: ProgressCallback | None = None,
    should_cancel: CancelCheck | None = None,
) -> dict[str, Any]:
    _require_provider()
    source = _approved_layout_source(payload)
    semantic_layout = _semantic_layout_value(payload)
    if not semantic_layout:
        raise ProcessorError("INPUT_REJECTED", "semanticLayout 不能为空")
    variants = list(payload.get("variants") or [])
    if not variants or any(item not in COLOR_PLAN_VARIANTS for item in variants):
        raise ProcessorError("INPUT_REJECTED", "彩平图类型无效")
    size = _target_size(source)
    references = _reference_paths(payload)

    def generate_one(variant: str) -> dict[str, Any]:
        prompt = (
            "Generate one presentation-ready full-home color floor plan. "
            + _common_geometry_lock(semantic_layout)
            + "All images after image 1 are style references only and must never contribute their "
            "layout, geometry, room count or furniture positions. Render the approved plan as "
            f"{COLOR_PLAN_DESCRIPTIONS[variant]}. Keep the entire plan visible with generous margin. "
            "Do not add dimensions or replace room labels with invented text. Additional design "
            f"requirement: {_design_requirement(payload)}."
        )
        try:
            generated = _generate(
                source=source,
                references=references,
                prompt=prompt,
                size=size,
            )
        except ProcessorError as exc:
            return _failed_output(
                variant_id=variant,
                variant_group_id=payload["variant_group_id"],
                error=exc,
            )
        return {
            "variantId": variant,
            "variantGroupId": payload["variant_group_id"],
            "status": "succeeded",
            "url": generated["url"],
            "provider": generated["provider"],
            "model": generated["model"],
            "size": generated["size"],
            "quality": generated["quality"],
        }

    def build_result(outputs: list[dict[str, Any]]) -> dict[str, Any]:
        result = _base_result(
            payload,
            stage="color_plan",
            source=source,
            semantic_layout=semantic_layout,
            outputs=outputs,
        )
        result["inputRoles"] = {
            "image1": "approved_layout_geometry_authority",
            "semanticLayout": "geometry_and_room_semantics_authority",
            "styleReferences": "appearance_only",
        }
        return result

    result = _fanout_generate(variants, generate_one, build_result, on_progress, should_cancel)
    _raise_if_batch_failed(result, "彩平图")
    return result


def run_ai_axonometric(
    payload: dict[str, Any],
    on_progress: ProgressCallback | None = None,
    should_cancel: CancelCheck | None = None,
) -> dict[str, Any]:
    _require_provider()
    source = _approved_layout_source(payload)
    semantic_layout = _semantic_layout_value(payload)
    if not semantic_layout:
        raise ProcessorError("INPUT_REJECTED", "semanticLayout 不能为空")
    variants = list(payload.get("variants") or [])
    if not variants or any(item not in AXONOMETRIC_VARIANTS for item in variants):
        raise ProcessorError("INPUT_REJECTED", "轴侧图类型无效")
    approved_color_plan = _existing_image(
        payload.get("approved_color_plan_path"),
        "已批准彩平图",
    )
    references = _reference_paths(payload, approved_color_plan)
    size = _target_size(source)

    def generate_one(variant: str) -> dict[str, Any]:
        prompt = (
            "Generate one presentation-ready full-home architectural axonometric image. "
            + _common_geometry_lock(semantic_layout)
            + (
                "Image 2 is the approved color-plan appearance baseline: preserve its material, "
                "furniture identity and color language but never use it to override image 1 geometry. "
                if approved_color_plan
                else ""
            )
            + "Any remaining images are appearance references only. Convert the exact approved plan "
            f"into {AXONOMETRIC_DESCRIPTIONS[variant]}. Maintain plausible and consistent wall "
            "heights; show every room in its correct relative position. No exploded parts, no missing "
            "rooms, no duplicate furniture, no text labels and no perspective distortion that changes "
            f"the footprint. Additional design requirement: {_design_requirement(payload)}."
        )
        try:
            generated = _generate(
                source=source,
                references=references,
                prompt=prompt,
                size=size,
            )
        except ProcessorError as exc:
            return _failed_output(
                variant_id=variant,
                variant_group_id=payload["variant_group_id"],
                error=exc,
            )
        return {
            "variantId": variant,
            "variantGroupId": payload["variant_group_id"],
            "status": "succeeded",
            "url": generated["url"],
            "provider": generated["provider"],
            "model": generated["model"],
            "size": generated["size"],
            "quality": generated["quality"],
        }

    def build_result(outputs: list[dict[str, Any]]) -> dict[str, Any]:
        result = _base_result(
            payload,
            stage="axonometric",
            source=source,
            semantic_layout=semantic_layout,
            outputs=outputs,
        )
        result["approvedColorPlan"] = (
            {
                "imageUrl": artifact_url(approved_color_plan),
                "sha256": _image_sha256(approved_color_plan),
            }
            if approved_color_plan
            else None
        )
        result["inputRoles"] = {
            "image1": "approved_layout_geometry_authority",
            "semanticLayout": "geometry_and_room_semantics_authority",
            "approvedColorPlan": "appearance_baseline",
            "styleReferences": "appearance_only",
        }
        return result

    result = _fanout_generate(variants, generate_one, build_result, on_progress, should_cancel)
    _raise_if_batch_failed(result, "轴侧图")
    return result


def _semantic_rooms(layout: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rooms: dict[str, dict[str, Any]] = {}
    for index, room in enumerate(_as_list(layout.get("rooms")), start=1):
        if not isinstance(room, dict):
            continue
        room_id = room.get("id")
        if not isinstance(room_id, str) or not room_id.strip():
            room_id = f"room_{index}"
        rooms[room_id] = room
    return rooms


def run_ai_space_render(
    payload: dict[str, Any],
    on_progress: ProgressCallback | None = None,
    should_cancel: CancelCheck | None = None,
) -> dict[str, Any]:
    _require_provider()
    source = _approved_layout_source(payload)
    semantic_layout = _semantic_layout_value(payload)
    if not semantic_layout:
        raise ProcessorError("INPUT_REJECTED", "semanticLayout 不能为空")
    rooms = _semantic_rooms(semantic_layout)
    if not rooms:
        raise ProcessorError("INPUT_REJECTED", "semanticLayout 中没有可生成的空间")
    selected_ids = list(payload.get("selected_space_ids") or rooms.keys())
    unknown_ids = [room_id for room_id in selected_ids if room_id not in rooms]
    if unknown_ids:
        raise ProcessorError(
            "INPUT_REJECTED",
            f"未找到选中的空间：{', '.join(unknown_ids)}",
        )
    if len(selected_ids) > 12:
        raise ProcessorError("INPUT_REJECTED", "单次最多生成 12 个空间")
    approved_color_plan = _existing_image(
        payload.get("approved_color_plan_path"),
        "已批准彩平图",
    )
    references = _reference_paths(payload, approved_color_plan)
    view_preset = str(payload.get("view_preset") or "eye_level_wide")
    size = _target_size(source)
    semantic_prompt = _semantic_prompt(semantic_layout)

    def generate_one(room_id: str) -> dict[str, Any]:
        room = rooms[room_id]
        room_name = str(room.get("name") or room.get("type") or room_id)
        room_json = json.dumps(room, ensure_ascii=False, separators=(",", ":"))
        prompt = (
            "Generate one realistic interior architectural visualization of exactly one selected "
            "space from the approved home layout. INPUT ROLE LOCK: image 1 is the complete approved "
            "layout and sole footprint authority. Do not redesign the plan. The complete "
            f"semanticLayout authority is: {semantic_prompt}. The target space is {room_name} "
            f"(id={room_id}) with this exact semantic record: {room_json}. Show only a believable "
            "interior camera view from inside that target space, while keeping every visible wall, "
            "door, window, opening and furniture category consistent with the target record and its "
            "adjacencies in the full plan. "
            + (
                "Image 2 is the approved whole-home color-plan appearance baseline; inherit its "
                "materials, palette and furniture identity without copying its camera. "
                if approved_color_plan
                else ""
            )
            + "Any remaining images control appearance only. Use a professional eye-level wide-angle "
            f"architectural camera preset ({view_preset}) with natural proportions, not a dollhouse "
            "view and not a top-down plan. Do not make the room smaller or overcrowded. Do not add "
            "doors, windows, furniture or decor that conflicts with the approved inputs. Additional "
            f"design requirement: {_design_requirement(payload)}."
        )
        try:
            generated = _generate(
                source=source,
                references=references,
                prompt=prompt,
                size=size,
            )
        except ProcessorError as exc:
            return _failed_output(
                variant_id=f"space_{room_id}",
                variant_group_id=payload["variant_group_id"],
                error=exc,
                extra={
                    "spaceId": room_id,
                    "spaceName": room_name,
                    "spaceType": room.get("type"),
                    "viewPreset": view_preset,
                },
            )
        return {
            "variantId": f"space_{room_id}",
            "variantGroupId": payload["variant_group_id"],
            "status": "succeeded",
            "spaceId": room_id,
            "spaceName": room_name,
            "spaceType": room.get("type"),
            "viewPreset": view_preset,
            "url": generated["url"],
            "provider": generated["provider"],
            "model": generated["model"],
            "size": generated["size"],
            "quality": generated["quality"],
        }

    def build_result(outputs: list[dict[str, Any]]) -> dict[str, Any]:
        result = _base_result(
            payload,
            stage="space_render",
            source=source,
            semantic_layout=semantic_layout,
            outputs=outputs,
        )
        result["selectedSpaceIds"] = selected_ids
        result["viewPreset"] = view_preset
        result["approvedColorPlan"] = (
            {
                "imageUrl": artifact_url(approved_color_plan),
                "sha256": _image_sha256(approved_color_plan),
            }
            if approved_color_plan
            else None
        )
        result["inputRoles"] = {
            "image1": "approved_layout_geometry_authority",
            "semanticLayout": "geometry_room_and_adjacency_authority",
            "approvedColorPlan": "whole_home_appearance_baseline",
            "styleReferences": "appearance_only",
        }
        return result

    result = _fanout_generate(selected_ids, generate_one, build_result, on_progress, should_cancel)
    _raise_if_batch_failed(result, "分空间效果图")
    return result


def _approved_space_source(payload: dict[str, Any]) -> Path:
    if payload.get("source_approved") is not True:
        raise ProcessorError(
            "SPACE_APPROVAL_REQUIRED",
            "只有显式确认已批准的空间效果图才能进入后续派生阶段",
        )
    return _existing_image(payload.get("source_space_path"), "已批准空间效果图")


def _source_space_summary(payload: dict[str, Any], source: Path) -> dict[str, Any]:
    source_sha256 = _image_sha256(source)
    return {
        "spaceId": payload.get("space_id"),
        "versionId": payload.get("parent_approved_version_id")
        or payload.get("source_space_version_id"),
        "assetId": payload.get("asset_parent_id"),
        "parentApprovedVersionId": payload.get("parent_approved_version_id")
        or payload.get("source_space_version_id"),
        "parentVariantId": payload.get("parent_variant_id"),
        "sourceSha256": payload.get("source_sha256") or source_sha256,
        "sha256": payload.get("source_sha256") or source_sha256,
        "imageUrl": artifact_url(source),
        "approvalConfirmed": payload.get("source_approved") is True,
    }


def _space_record(layout: dict[str, Any], space_id: str) -> dict[str, Any]:
    rooms = _semantic_rooms(layout)
    room = rooms.get(space_id)
    if room is None:
        raise ProcessorError(
            "INPUT_REJECTED",
            f"spaceId 不属于 semanticLayout.rooms：{space_id}",
        )
    return room


def _space_geometry_lock(layout: dict[str, Any], space_id: str) -> str:
    room = _space_record(layout, space_id)
    room_json = json.dumps(room, ensure_ascii=False, separators=(",", ":"))
    return (
        "INPUT ROLE LOCK: image 1 is the user-approved space render and the sole camera, composition "
        "and visible-geometry authority. Preserve the exact camera position, lens, crop, perspective, "
        "walls, ceiling, floor boundaries, doors, windows, built-ins, furniture identity, furniture "
        "count, furniture position and object silhouette. Never rotate, mirror, widen, crop, move or "
        "invent architecture or furniture. The target semantic room is "
        f"spaceId={space_id}: {room_json}. The complete semanticLayout remains a secondary geometry "
        f"authority: {_semantic_prompt(layout)}. "
    )


def _derivative_result(
    payload: dict[str, Any],
    *,
    stage: str,
    source: Path,
    semantic_layout: dict[str, Any],
    outputs: list[dict[str, Any]],
) -> dict[str, Any]:
    successful = [item for item in outputs if item.get("status") == "succeeded"]
    failed = [item for item in outputs if item.get("status") == "failed"]
    first = successful[0] if successful else {}
    return {
        "workflowStage": stage,
        "variantGroupId": payload["variant_group_id"],
        "generationMode": "ai_image",
        "provider": first.get("provider"),
        "model": first.get("model") or settings.kuyao_image_model,
        "promptVersion": WORKFLOW_PROMPT_VERSION,
        "sourceSpace": _source_space_summary(payload, source),
        "semanticInput": _semantic_summary(semantic_layout),
        "spaceId": payload.get("space_id"),
        "outputs": outputs,
        "count": len(outputs),
        "succeededCount": len(successful),
        "failedCount": len(failed),
        "batchStatus": "complete" if not failed else ("partial" if successful else "failed"),
        "partialOutputs": successful if failed else [],
        "approvalStatus": "review_required",
        "structureAudit": {
            "performed": False,
            "geometryGuaranteed": False,
            "requiresManualReview": True,
            "notice": "阶段 6～8 保留已批准空间图的机位与构图，但仍须人工核对生成区域。",
        },
        "isConceptOnly": True,
        "constructionReady": False,
        "requiresUserConfirmation": True,
        "notice": "结果从已批准空间效果图派生，进入下一阶段前必须人工确认。",
    }


def run_ai_style_scheme(
    payload: dict[str, Any],
    on_progress: ProgressCallback | None = None,
    should_cancel: CancelCheck | None = None,
) -> dict[str, Any]:
    """Stage 6: restyle one approved space without changing its camera or layout."""

    _require_provider()
    source = _approved_space_source(payload)
    semantic_layout = _semantic_layout_value(payload)
    if not semantic_layout:
        raise ProcessorError("INPUT_REJECTED", "semanticLayout 不能为空")
    space_id = str(payload.get("space_id") or "")
    variants = list(payload.get("variants") or [])
    if not variants or any(item not in STYLE_SCHEME_VARIANTS for item in variants):
        raise ProcessorError("INPUT_REJECTED", "风格方案类型无效")
    lock = _space_geometry_lock(semantic_layout, space_id)
    references = _reference_paths(payload)
    size = _target_size(source)

    def generate_one(variant: str) -> dict[str, Any]:
        prompt = (
            "Create one presentation-ready alternate interior style for the exact approved space. "
            + lock
            + "Keep the camera, every object's footprint and scale, but commit fully to a new "
            "interior identity: repaint the walls, replace floor and wall materials, redesign all "
            "loose furniture in the target design language, and change textiles, lighting "
            "fixtures and decor accordingly. Do NOT preserve the source image's original color "
            "scheme, material palette or furniture styling — the result must be instantly "
            "recognizable as the target style and clearly different from the source. All images "
            "after image 1 are appearance-only references and must not contribute geometry. "
            f"Target style: {STYLE_SCHEME_DESCRIPTIONS[variant]}. Additional requirement: "
            f"{_design_requirement(payload)}."
        )
        try:
            generated = _generate(
                source=source,
                references=references,
                prompt=prompt,
                size=size,
            )
        except ProcessorError as exc:
            return _failed_output(
                variant_id=f"style_{variant}",
                variant_group_id=payload["variant_group_id"],
                error=exc,
                extra={"spaceId": space_id, "styleId": variant},
            )
        return {
            "variantId": f"style_{variant}",
            "variantGroupId": payload["variant_group_id"],
            "status": "succeeded",
            "spaceId": space_id,
            "styleId": variant,
            "url": generated["url"],
            "provider": generated["provider"],
            "model": generated["model"],
            "size": generated["size"],
            "quality": generated["quality"],
        }

    def build_result(outputs: list[dict[str, Any]]) -> dict[str, Any]:
        result = _derivative_result(
            payload,
            stage="style_scheme",
            source=source,
            semantic_layout=semantic_layout,
            outputs=outputs,
        )
        result["inputRoles"] = {
            "image1": "approved_space_camera_and_geometry_authority",
            "semanticLayout": "room_semantics_authority",
            "styleReferences": "appearance_only",
        }
        return result

    result = _fanout_generate(variants, generate_one, build_result, on_progress, should_cancel)
    _raise_if_batch_failed(result, "风格方案")
    return result


def run_ai_tone_scheme(
    payload: dict[str, Any],
    on_progress: ProgressCallback | None = None,
    should_cancel: CancelCheck | None = None,
) -> dict[str, Any]:
    """Stage 7: vary only color temperature, exposure and mood of an approved style."""

    _require_provider()
    source = _approved_space_source(payload)
    semantic_layout = _semantic_layout_value(payload)
    if not semantic_layout:
        raise ProcessorError("INPUT_REJECTED", "semanticLayout 不能为空")
    space_id = str(payload.get("space_id") or "")
    variants = list(payload.get("variants") or [])
    if not variants or any(item not in TONE_SCHEME_VARIANTS for item in variants):
        raise ProcessorError("INPUT_REJECTED", "色调方案类型无效")
    lock = _space_geometry_lock(semantic_layout, space_id)
    size = _target_size(source)

    def generate_one(variant: str) -> dict[str, Any]:
        prompt = (
            "Create one alternate color-tone treatment of the exact approved interior image. "
            + lock
            + "Do not restyle, replace, move or resize any material, furniture, fixture or decor. "
            "Change only white balance, color temperature, exposure, contrast, shadow softness and "
            f"lighting mood. Apply: {TONE_SCHEME_DESCRIPTIONS[variant]}. Additional requirement: "
            f"{_design_requirement(payload)}."
        )
        try:
            generated = _generate(
                source=source,
                references=[],
                prompt=prompt,
                size=size,
            )
        except ProcessorError as exc:
            return _failed_output(
                variant_id=f"tone_{variant}",
                variant_group_id=payload["variant_group_id"],
                error=exc,
                extra={"spaceId": space_id, "toneId": variant},
            )
        return {
            "variantId": f"tone_{variant}",
            "variantGroupId": payload["variant_group_id"],
            "status": "succeeded",
            "spaceId": space_id,
            "toneId": variant,
            "url": generated["url"],
            "provider": generated["provider"],
            "model": generated["model"],
            "size": generated["size"],
            "quality": generated["quality"],
        }

    def build_result(outputs: list[dict[str, Any]]) -> dict[str, Any]:
        result = _derivative_result(
            payload,
            stage="tone_scheme",
            source=source,
            semantic_layout=semantic_layout,
            outputs=outputs,
        )
        result["inputRoles"] = {
            "image1": "approved_style_camera_geometry_and_material_authority",
            "semanticLayout": "room_semantics_authority",
        }
        return result

    result = _fanout_generate(variants, generate_one, build_result, on_progress, should_cancel)
    _raise_if_batch_failed(result, "色调方案")
    return result


def _extract_mark_mask(*, source: Path, mark: Path) -> tuple[Path, float]:
    """Extract the editable region from red annotation marks drawn on the source.

    The browser annotator paints pure #FF3B30 strokes over the approved image.
    Users typically *circle* the object they want changed rather than painting
    it solid, so after thresholding the red strokes we close small gaps and
    flood-fill every enclosed contour interior; otherwise only the stroke ring
    itself would be regenerated and the circled object would stay untouched.
    """

    source_image = cv2.imread(str(source), cv2.IMREAD_COLOR)
    mark_image = cv2.imread(str(mark), cv2.IMREAD_COLOR)
    if source_image is None or mark_image is None:
        raise ProcessorError("INPUT_REJECTED", "无法读取局部修改原图或标记图")
    if mark_image.shape[:2] != source_image.shape[:2]:
        mark_image = cv2.resize(
            mark_image,
            (source_image.shape[1], source_image.shape[0]),
            interpolation=cv2.INTER_LINEAR,
        )
    blue, green, red = cv2.split(mark_image.astype(np.int16))
    red_like = (red > 150) & (red - green > 60) & (red - blue > 60)
    # Warm-toned scenes contain plenty of naturally reddish pixels (wood,
    # sunset light). Only pixels that actually changed against the source are
    # user-drawn marks; natural red background must not become editable.
    diff = np.abs(mark_image.astype(np.int16) - source_image.astype(np.int16)).sum(axis=2)
    strokes = (red_like & (diff > 40)).astype(np.uint8) * 255
    if not int((strokes >= 128).sum()):
        raise ProcessorError(
            "INPUT_REJECTED",
            "未检测到红色标记区域，请先在浏览器中用画笔标出需要修改的部分",
        )
    # Seal anti-alias gaps along hand-drawn rings, then fill each closed
    # contour so a circled object becomes a fully editable region.
    close_kernel = np.ones((9, 9), dtype=np.uint8)
    closed = cv2.morphologyEx(strokes, cv2.MORPH_CLOSE, close_kernel, iterations=2)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_area = max(64.0, float(source_image.shape[0] * source_image.shape[1]) * 0.0002)
    kept = [contour for contour in contours if cv2.contourArea(contour) >= min_area]
    selected = strokes
    if kept:
        filled = np.zeros_like(strokes)
        cv2.drawContours(filled, kept, -1, 255, thickness=cv2.FILLED)
        selected = cv2.bitwise_or(filled, strokes)
    edge_kernel = np.ones((3, 3), dtype=np.uint8)
    selected = cv2.dilate(selected, edge_kernel, iterations=2)
    coverage = float((selected >= 128).mean())
    if coverage <= 0:
        raise ProcessorError(
            "INPUT_REJECTED",
            "未检测到红色标记区域，请先在浏览器中用画笔标出需要修改的部分",
        )
    mask_path = artifact_path("ai-local-edit-mask", ".png")
    success, encoded = cv2.imencode(".png", selected)
    if not success:
        raise ProcessorError("GENERATION_FAILED", "标记区域提取失败")
    try:
        mask_path.write_bytes(encoded.tobytes())
    except OSError as exc:
        raise ProcessorError("GENERATION_FAILED", "标记区域保存失败") from exc
    return mask_path, coverage


def _restore_unmasked_pixels(
    *,
    source: Path,
    generated: Path,
    mask: Path,
) -> tuple[Path, float]:
    source_image = cv2.imread(str(source), cv2.IMREAD_COLOR)
    generated_image = cv2.imread(str(generated), cv2.IMREAD_COLOR)
    mask_image = cv2.imread(str(mask), cv2.IMREAD_GRAYSCALE)
    if source_image is None or generated_image is None or mask_image is None:
        raise ProcessorError("INPUT_REJECTED", "无法读取局部修改原图、生成图或遮罩图")
    if mask_image.shape[:2] != source_image.shape[:2]:
        raise ProcessorError("INPUT_REJECTED", "遮罩图尺寸必须与已批准空间效果图完全一致")
    selected = mask_image >= 128
    coverage = float(selected.mean())
    if coverage <= 0:
        raise ProcessorError("INPUT_REJECTED", "遮罩图没有可修改的白色区域")
    if generated_image.shape[:2] != source_image.shape[:2]:
        generated_image = cv2.resize(
            generated_image,
            (source_image.shape[1], source_image.shape[0]),
            interpolation=cv2.INTER_LANCZOS4,
        )
    composite = source_image.copy()
    composite[selected] = generated_image[selected]
    output = artifact_path("ai-local-edit", ".png")
    success, encoded = cv2.imencode(".png", composite)
    if not success:
        raise ProcessorError("GENERATION_FAILED", "局部修改结果编码失败")
    try:
        output.write_bytes(encoded.tobytes())
    except OSError as exc:
        raise ProcessorError("GENERATION_FAILED", "局部修改结果保存失败") from exc
    return output, coverage


def run_ai_local_edit(payload: dict[str, Any]) -> dict[str, Any]:
    """Stage 8: edit only the red-marked regions and hard-restore every other pixel."""

    _require_provider()
    source = _approved_space_source(payload)
    semantic_layout = _semantic_layout_value(payload)
    if not semantic_layout:
        raise ProcessorError("INPUT_REJECTED", "semanticLayout 不能为空")
    space_id = str(payload.get("space_id") or "")
    mark = _existing_image(payload.get("mark_path"), "局部修改标记图")
    edit_prompt = str(payload.get("edit_prompt") or "").strip()
    if not edit_prompt:
        raise ProcessorError("INPUT_REJECTED", "局部修改要求不能为空")
    lock = _space_geometry_lock(semantic_layout, space_id)
    # 局部修改必须「一眼看得出变化」：过往 gpt-image 常几乎原样返回，
    # 再被 hard-restore 后看起来像「没效果」。
    prompt = (
        "You are doing a LOCAL object edit of an approved interior photograph. "
        + lock
        + "Image 1 is the authority photo (camera, geometry, lighting, unedited furniture). "
        "Image 2 is the SAME photo with bright pure-red (#FF3B30) hand-drawn marks. "
        "The red strokes circle or paint ONE target: everything INSIDE / covered by the red "
        "markings is the ONLY region you may change. "
        "User request (apply only inside the red marks): "
        f"{edit_prompt}. "
        "CRITICAL SUCCESS CRITERIA: "
        "1) The edited object MUST be OBVIOUSLY different from image 1 (e.g. clearly new "
        "color/material/finish). A subtle tint shift is a FAILURE — make a bold, visible edit. "
        "2) If the request is a color change, repaint the whole marked object with a distinctly "
        "different hue or wood/metal/fabric finish that reads clearly at a glance. "
        "3) Do NOT leave the marked object looking like a copy of image 1. "
        "4) Keep the object's silhouette, position, scale, and perspective coherent with the room. "
        "5) Everything outside the red marks must match image 1. "
        "6) The finished image must contain NO red annotation strokes. "
        "The server will hard-restore every non-marked pixel after generation."
    )
    try:
        mask, mark_coverage = _extract_mark_mask(source=source, mark=mark)
        # 同时把二值 mask 作为参考，强化「只改白区」
        generated = _generate(
            source=source,
            references=[mark, mask],
            prompt=prompt
            + " Image 3 is a binary mask of the editable region (white = must edit). "
            "Apply the requested change across the entire white region, not only the red ring.",
            size=_target_size(source),
        )
        composite_path, coverage = _restore_unmasked_pixels(
            source=source,
            generated=Path(generated["path"]),
            mask=mask,
        )
        outputs = [
            {
                "variantId": "local_edit",
                "variantGroupId": payload["variant_group_id"],
                "status": "succeeded",
                "spaceId": space_id,
                "url": artifact_url(composite_path),
                "provider": generated["provider"],
                "model": generated["model"],
                "size": f"{cv2.imread(str(source)).shape[1]}x{cv2.imread(str(source)).shape[0]}",
                "quality": generated["quality"],
                "maskCoverage": round(coverage, 6),
                "markCoverage": round(mark_coverage, 6),
                "unmaskedPixelsRestored": True,
            }
        ]
    except ProcessorError as exc:
        outputs = [
            _failed_output(
                variant_id="local_edit",
                variant_group_id=payload["variant_group_id"],
                error=exc,
                extra={"spaceId": space_id},
            )
        ]
    result = _derivative_result(
        payload,
        stage="local_edit",
        source=source,
        semantic_layout=semantic_layout,
        outputs=outputs,
    )
    result["editPrompt"] = edit_prompt
    result["mask"] = {
        "imageUrl": artifact_url(mark),
        "sha256": _image_sha256(mark),
        "unmaskedPixelsRestored": bool(
            outputs and outputs[0].get("unmaskedPixelsRestored")
        ),
    }
    result["inputRoles"] = {
        "image1": "approved_tone_camera_geometry_and_appearance_authority",
        "semanticLayout": "room_semantics_authority",
        "image2": "user_red_annotation_marks",
    }
    _raise_if_batch_failed(result, "局部修改")
    return result
