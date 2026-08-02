from __future__ import annotations

from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Job, SceneAsset
from app.schemas import to_camel
from app.storage import artifact_url


LOCAL_OWNER_ID = "local-user"

ASSET_MODULES: dict[str, dict[str, str]] = {
    "floorplan": {
        "name": "户型识别与效果图",
        "description": "平面图识别、结构校正、三维场景与受控效果图",
    },
    "layout": {
        "name": "AI 平面布局",
        "description": "AI 生成的家具平面布局概念方案；历史布局资产保留只读浏览",
    },
    "white_model": {
        "name": "白模渲染",
        "description": "本地保真预览或 AI 白模写实渲染",
    },
    "effect_render": {
        "name": "历史快速房间渲染",
        "description": "兼容旧版单房间参数化渲染资产与生成记录",
    },
    "material_replacement": {
        "name": "AI 多材质替换",
        "description": "使用蒙版约束 AI 重绘墙面与地面材质；失败时明确记录本地回退",
    },
}

JOB_TYPE_TO_MODULE = {
    "FLOORPLAN_SCENE": "floorplan",
    "LAYOUT": "layout",
    "LAYOUT_AI": "layout",
    "WHITE_MODEL_RENDER": "white_model",
    "EFFECT_RENDER": "effect_render",
    "MATERIAL_REPLACEMENT": "material_replacement",
}

ASSET_JOB_TYPES = frozenset(JOB_TYPE_TO_MODULE)


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _camelize(value: Any) -> Any:
    if isinstance(value, dict):
        return {to_camel(str(key)): _camelize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_camelize(item) for item in value]
    return value


def asset_modules() -> list[dict[str, str]]:
    return [
        {
            "key": key,
            "name": value["name"],
            "description": value["description"],
        }
        for key, value in ASSET_MODULES.items()
    ]


def _valid_module_key(value: Any) -> str | None:
    return value if isinstance(value, str) and value in ASSET_MODULES else None


def _module_key(job: Job, parent_asset: SceneAsset | None = None) -> str:
    if parent_asset is not None:
        inherited = _valid_module_key(_mapping(parent_asset.metadata_json).get("moduleKey"))
        if inherited:
            return inherited
    explicit = _valid_module_key(_mapping(job.payload).get("asset_module_key"))
    return explicit or JOB_TYPE_TO_MODULE[job.type]


def _module_name(module_key: str) -> str:
    return ASSET_MODULES[module_key]["name"]


def _path_url(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    if value.startswith(("http://", "https://", "/artifacts/", "/examples/")):
        return value
    return artifact_url(value)


def _asset_title(job: Job, result: dict[str, Any]) -> str:
    payload = _mapping(job.payload)
    explicit_title = payload.get("asset_title")
    if isinstance(explicit_title, str) and explicit_title.strip():
        return explicit_title.strip()[:160]
    room = _mapping(result.get("room"))
    room_name = payload.get("room_name") or room.get("name")
    room_labels = {
        "whole_home": "全屋",
        "living_room": "客厅",
        "dining_room": "餐厅",
        "bedroom": "卧室",
    }
    room_label = room_labels.get(payload.get("room_type"), payload.get("room_type"))
    if job.type in {"LAYOUT", "LAYOUT_AI"}:
        prefix = "AI 平面布局" if job.type == "LAYOUT_AI" else "平面布局"
        title = f"{prefix} · {room_label}" if room_label else prefix
        return title[:160]
    if job.type == "WHITE_MODEL_RENDER":
        title = f"白模渲染 · {room_label}" if room_label else "白模渲染"
        return title[:160]
    if job.type == "EFFECT_RENDER":
        title = (
            f"历史快速房间渲染 · {room_label}"
            if room_label
            else "历史快速房间渲染"
        )
        return title[:160]
    if job.type == "MATERIAL_REPLACEMENT":
        return "AI 多材质替换"

    base_title = room_name or "室内设计效果图"
    variant_type = payload.get("asset_variant_type")
    if variant_type == "camera":
        labels = {
            "corner_01": "右前角",
            "corner_02": "左前角",
            "eye_level_01": "1.6 米平视",
        }
        title = f"{base_title} · 机位 · {labels.get(payload.get('camera_preset_id'), '自定义')}"
    elif variant_type == "material":
        labels = {
            "modern_warm_v1": "现代暖调",
            "modern_minimal_v1": "现代极简",
            "natural_wood_v1": "自然原木",
        }
        title = f"{base_title} · 材质 · {labels.get(payload.get('style_preset_id'), '自定义')}"
    else:
        title = base_title
    if isinstance(title, str) and title.strip():
        return title.strip()[:160]
    return "室内设计效果图"


def _asset_deliverables(job: Job, result: dict[str, Any]) -> dict[str, Any]:
    payload = _mapping(job.payload)
    source_image_url = payload.get("source_image_url") or _path_url(
        payload.get("source_path")
    )
    if job.type in {"LAYOUT", "LAYOUT_AI"}:
        layouts = result.get("layouts") if isinstance(result.get("layouts"), list) else []
        preview_urls = [
            layout.get("previewUrl")
            for layout in layouts
            if isinstance(layout, dict) and isinstance(layout.get("previewUrl"), str)
        ]
        return {
            "sourceImageUrl": source_image_url,
            "previewUrl": preview_urls[0] if preview_urls else None,
            "previewUrls": preview_urls,
            "capabilities": {
                "editableModel": False,
                "multiView": False,
                "materialReplacement": False,
                "glbDelivery": False,
            },
        }
    if job.type == "WHITE_MODEL_RENDER":
        outputs = result.get("outputs") if isinstance(result.get("outputs"), list) else []
        output_urls = [
            output.get("url")
            for output in outputs
            if isinstance(output, dict) and isinstance(output.get("url"), str)
        ]
        return {
            "sourceImageUrl": source_image_url,
            "controlImageUrl": result.get("controlImageUrl"),
            "finalRenderUrl": output_urls[0] if output_urls else None,
            "outputUrls": output_urls,
            "capabilities": {
                "editableModel": False,
                "multiView": False,
                "materialReplacement": False,
                "glbDelivery": False,
            },
        }
    if job.type == "EFFECT_RENDER":
        return {
            "sourceImageUrl": source_image_url,
            "baseRenderUrl": result.get("baseRenderUrl"),
            "finalRenderUrl": result.get("outputUrl"),
            "capabilities": {
                "editableModel": False,
                "multiView": False,
                "materialReplacement": False,
                "glbDelivery": False,
            },
        }
    if job.type == "MATERIAL_REPLACEMENT":
        return {
            "sourceImageUrl": source_image_url,
            "finalRenderUrl": result.get("outputUrl"),
            "comparisonUrl": result.get("comparisonUrl"),
            "capabilities": {
                "editableModel": False,
                "multiView": False,
                "materialReplacement": True,
                "glbDelivery": False,
            },
        }

    model_delivery = _mapping(result.get("modelDelivery"))
    generation_mode = str(
        result.get("generationMode") or payload.get("generation_mode") or "structured_3d"
    )
    dollhouse_url = result.get("dollhouseUrl")
    blend_url = model_delivery.get("blendUrl")
    glb_url = model_delivery.get("glbUrl")
    if (
        generation_mode == "structured_3d"
        and result.get("provider") == "blender-floorplan-headless"
        and isinstance(dollhouse_url, str)
    ):
        canonical_path = settings.artifact_dir / Path(dollhouse_url).name
        historical_blend = canonical_path.with_suffix(".blend")
        historical_glb = canonical_path.with_suffix(".glb")
        if not blend_url and historical_blend.is_file():
            blend_url = artifact_url(historical_blend)
        if not glb_url and historical_glb.is_file():
            glb_url = artifact_url(historical_glb)
    control_images = _mapping(result.get("controlImages"))
    capabilities = {
        "editableModel": bool(model_delivery.get("editable") or blend_url),
        "multiView": bool(model_delivery.get("cameraPresets")),
        "materialReplacement": bool(model_delivery.get("materialPresets")),
        "glbDelivery": bool(glb_url),
        **_mapping(model_delivery.get("capabilities")),
    }
    return {
        "sourceImageUrl": source_image_url,
        "topDownUrl": result.get("topDownUrl"),
        "roomPreviewUrl": result.get("roomPreviewUrl"),
        "dollhouseUrl": dollhouse_url,
        "baseRenderUrl": result.get("baseRenderUrl"),
        "finalRenderUrl": result.get("finalRenderUrl") or result.get("effectUrl"),
        "semanticUrl": control_images.get("semanticUrl"),
        "depthUrl": control_images.get("depthUrl"),
        "manifestUrl": result.get("manifestUrl"),
        "blendUrl": blend_url,
        "glbUrl": glb_url,
        "capabilities": capabilities,
    }


def _asset_metadata(
    job: Job,
    result: dict[str, Any],
    *,
    module_key: str,
) -> dict[str, Any]:
    payload = _mapping(job.payload)
    return {
        "moduleKey": module_key,
        "moduleName": _module_name(module_key),
        "jobType": job.type,
        "variantType": payload.get("asset_variant_type"),
        "cameraPresetId": payload.get("camera_preset_id"),
        "stylePresetId": payload.get("style_preset_id"),
        "renderQuality": payload.get("render_quality"),
        "sceneDigest": result.get("sceneDigest"),
        "provider": result.get("provider"),
        "model": result.get("model"),
        "requestedProvider": result.get("requestedProvider"),
        "requestedModel": result.get("requestedModel"),
        "fallbackUsed": result.get("fallbackUsed"),
        "fallbackReason": result.get("fallbackReason"),
        "notice": result.get("notice"),
        "structureCheck": result.get("structureCheck") or {},
        "renderType": result.get("renderType"),
        "room": result.get("room") or {},
        "renderInfo": result.get("renderInfo") or {},
        "modelDelivery": result.get("modelDelivery") or {},
        "generationMode": _generation_mode(job, result),
    }


def _generation_mode(job: Job, result: dict[str, Any]) -> str:
    payload = _mapping(job.payload)
    explicit = result.get("generationMode") or payload.get("generation_mode")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    if job.type == "LAYOUT_AI":
        return "ai_image"
    if job.type == "LAYOUT":
        return "deterministic"
    if job.type == "WHITE_MODEL_RENDER":
        # White-model jobs created before generation_mode existed used the local adapter.
        return "local_preview"
    if job.type == "EFFECT_RENDER":
        return "structured_3d" if payload.get("use_blender") else "local_preview"
    if job.type == "MATERIAL_REPLACEMENT":
        return "local_edit"
    return "structured_3d"


def _asset_type(job: Job, generation_mode: str) -> str:
    if job.type == "FLOORPLAN_SCENE":
        return "structured_scene" if generation_mode == "structured_3d" else "ai_render"
    return {
        "LAYOUT": "layout_plan",
        "LAYOUT_AI": "layout_plan",
        "WHITE_MODEL_RENDER": "white_model_render",
        "EFFECT_RENDER": "effect_render",
        "MATERIAL_REPLACEMENT": "material_replacement",
    }[job.type]


def _thumbnail(deliverables: dict[str, Any]) -> str | None:
    for key in (
        "finalRenderUrl",
        "previewUrl",
        "dollhouseUrl",
        "baseRenderUrl",
        "comparisonUrl",
        "controlImageUrl",
    ):
        value = deliverables.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def ensure_scene_asset(session: Session, job: Job) -> SceneAsset | None:
    """Create exactly one local asset for every successful visual module job."""

    if job.type not in ASSET_JOB_TYPES or job.status != "SUCCEEDED":
        return None
    result = _mapping(job.result)
    if not result:
        return None

    payload = _mapping(job.payload)
    generation_mode = _generation_mode(job, result)
    parent_asset_id = payload.get("asset_parent_id")
    parent_asset = (
        session.get(SceneAsset, parent_asset_id)
        if isinstance(parent_asset_id, str)
        else None
    )
    if parent_asset is None:
        parent_asset_id = None
    module_key = _module_key(job, parent_asset)
    deliverables = _asset_deliverables(job, result)
    thumbnail_url = _thumbnail(deliverables)
    if not thumbnail_url:
        return None
    metadata = _asset_metadata(job, result, module_key=module_key)
    existing = session.scalar(select(SceneAsset).where(SceneAsset.job_id == job.id))
    if existing is not None:
        title = _asset_title(job, result)
        asset_type = _asset_type(job, generation_mode)
        changed = False
        if existing.title != title:
            existing.title = title
            changed = True
        if existing.deliverables != deliverables:
            existing.deliverables = deliverables
            changed = True
        if existing.metadata_json != metadata:
            existing.metadata_json = metadata
            changed = True
        if existing.thumbnail_url != thumbnail_url:
            existing.thumbnail_url = thumbnail_url
            changed = True
        if existing.generation_mode != generation_mode:
            existing.generation_mode = generation_mode
            changed = True
        if existing.asset_type != asset_type:
            existing.asset_type = asset_type
            changed = True
        if existing.parent_asset_id != parent_asset_id:
            existing.parent_asset_id = parent_asset_id
            changed = True
        if changed:
            session.flush()
        return existing

    asset = SceneAsset(
        owner_id=LOCAL_OWNER_ID,
        project_id=job.project_id,
        job_id=job.id,
        parent_asset_id=parent_asset_id,
        title=_asset_title(job, result),
        generation_mode=generation_mode,
        asset_type=_asset_type(job, generation_mode),
        thumbnail_url=thumbnail_url,
        deliverables=deliverables,
        metadata_json=metadata,
        created_at=job.created_at,
        updated_at=job.updated_at,
    )
    session.add(asset)
    session.flush()
    return asset


def backfill_scene_assets(session: Session) -> int:
    """Register old successful visual jobs and refresh their module metadata."""

    successful_jobs = list(
        session.scalars(
            select(Job)
            .where(
                Job.type.in_(ASSET_JOB_TYPES),
                Job.status == "SUCCEEDED",
            )
            .order_by(Job.created_at.asc())
        )
    )
    created = 0
    for job in successful_jobs:
        existed = session.scalar(select(SceneAsset.id).where(SceneAsset.job_id == job.id))
        if ensure_scene_asset(session, job) is not None:
            created += int(existed is None)
    if successful_jobs:
        session.commit()
    return created


def get_local_scene_asset(session: Session, asset_id: str) -> SceneAsset | None:
    return session.scalar(
        select(SceneAsset).where(
            SceneAsset.id == asset_id,
            SceneAsset.owner_id == LOCAL_OWNER_ID,
            SceneAsset.thumbnail_url.is_not(None),
        )
    )


def scene_asset_read(asset: SceneAsset) -> dict[str, Any]:
    metadata = asset.metadata_json or {}
    module_key = metadata.get("moduleKey")
    if module_key not in ASSET_MODULES:
        module_key = "floorplan"
    return {
        "id": asset.id,
        "owner_id": asset.owner_id,
        "project_id": asset.project_id,
        "job_id": asset.job_id,
        "parent_asset_id": asset.parent_asset_id,
        "title": asset.title,
        "generation_mode": asset.generation_mode,
        "asset_type": asset.asset_type,
        "module_key": module_key,
        "module_name": _module_name(module_key),
        "thumbnail_url": asset.thumbnail_url,
        "deliverables": asset.deliverables or {},
        "metadata": metadata,
        "created_at": asset.created_at,
        "updated_at": asset.updated_at,
    }


def scene_asset_detail(session: Session, asset: SceneAsset) -> dict[str, Any]:
    value = scene_asset_read(asset)
    job = session.get(Job, asset.job_id)
    value["source_payload"] = _camelize(job.payload) if job is not None else {}
    value["source_result"] = (
        _camelize(job.result) if job is not None and job.result is not None else {}
    )
    return value
