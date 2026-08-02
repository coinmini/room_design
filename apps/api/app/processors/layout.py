from __future__ import annotations

import html
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from shapely.geometry import box

from app.config import WORKSPACE_ROOT, settings
from app.processors.common import ProcessorError
from app.processors.kuyao_image_edit import edit_floorplan_image
from app.storage import artifact_path, artifact_url


COLORS = {
    "sofa": "#78A6D1",
    "coffee_table": "#D9B779",
    "tv_console": "#8090A0",
    "dining_table": "#C99472",
    "bed": "#83B6A4",
    "wardrobe": "#9C91BF",
}

AI_LAYOUT_TEMPLATES = {
    "builtin_floorplan_01": WORKSPACE_ROOT / "example" / "平面图.jpeg",
    "builtin_floorplan_02": WORKSPACE_ROOT / "example" / "平面图2.jpeg",
    "builtin_floorplan_03": WORKSPACE_ROOT / "example" / "平面图3.jpeg",
}
AI_LAYOUT_TEMPLATE_VERSION = "builtin-floorplans-v1"
AI_LAYOUT_PROMPT_VERSION = "ai-concept-layout-v1"
AI_LAYOUT_ROOM_NAMES = {
    "whole_home": "whole residential home",
    "living_room": "living room",
    "dining_room": "dining room",
    "bedroom": "bedroom",
}


def _item(
    category: str,
    x: float,
    y: float,
    width: float,
    depth: float,
    rotation: int = 0,
) -> dict[str, Any]:
    return {
        "id": f"{category}_{int(x)}_{int(y)}",
        "category": category,
        "xMm": round(x),
        "yMm": round(y),
        "widthMm": round(width),
        "depthMm": round(depth),
        "rotationDeg": rotation,
    }


def _placements(payload: dict[str, Any], variant: int) -> list[dict[str, Any]]:
    width = payload["width_mm"]
    depth = payload["depth_mm"]
    room_type = payload["room_type"]
    margin = 260

    if min(width, depth) < 2400:
        raise ProcessorError("SOLVER_NO_SOLUTION", "房间尺寸不足以放置最小家具组合")

    if room_type == "living_room":
        sofa_width = min(2200 + (payload["sofa_seats"] - 3) * 450, width - 700)
        sofa_depth = 900
        sofa_x = margin if variant == 0 else width - margin - sofa_width
        sofa_y = depth - margin - sofa_depth
        table_width, table_depth = (1100, 600) if variant == 0 else (900, 700)
        return [
            _item("sofa", sofa_x, sofa_y, sofa_width, sofa_depth),
            _item(
                "coffee_table",
                (width - table_width) / 2,
                max(margin + 500, (depth - table_depth) / 2),
                table_width,
                table_depth,
                0 if variant == 0 else 90,
            ),
            _item("tv_console", (width - 1800) / 2, margin, 1800, 360),
        ]

    if room_type == "dining_room":
        table_width = 1600 if payload["dining_seats"] <= 6 else 2200
        table_depth = 900
        if variant:
            table_width, table_depth = table_depth, table_width
        return [
            _item(
                "dining_table",
                (width - table_width) / 2,
                (depth - table_depth) / 2,
                table_width,
                table_depth,
                90 if variant else 0,
            )
        ]

    bed_width = 1500 if payload["bed_type"] == "bed_1500" else 1800
    bed_depth = 2000
    bed_x = (width - bed_width) / 2 if variant == 0 else margin
    return [
        _item("bed", bed_x, depth - margin - bed_depth, bed_width, bed_depth),
        _item(
            "wardrobe",
            width - margin - 600 if variant == 0 else width - margin - 1800,
            margin,
            600 if variant == 0 else 1800,
            1800 if variant == 0 else 600,
            90 if variant == 0 else 0,
        ),
    ]


def _validate(
    placements: list[dict[str, Any]],
    width: int,
    depth: int,
) -> list[str]:
    room = box(0, 0, width, depth)
    shapes: list[tuple[str, Any]] = []
    violations: list[str] = []
    for placement in placements:
        shape = box(
            placement["xMm"],
            placement["yMm"],
            placement["xMm"] + placement["widthMm"],
            placement["yMm"] + placement["depthMm"],
        )
        if not room.covers(shape):
            violations.append(f"{placement['category']} 超出房间")
        for other_id, other_shape in shapes:
            if shape.intersection(other_shape).area > 1:
                violations.append(
                    f"{placement['category']} 与 {other_id} 发生硬碰撞"
                )
        shapes.append((placement["category"], shape))
    return violations


def _svg(
    path: Path,
    placements: list[dict[str, Any]],
    width: int,
    depth: int,
    strategy: str,
) -> None:
    canvas_width, canvas_height, padding = 760, 520, 44
    scale = min(
        (canvas_width - padding * 2) / width,
        (canvas_height - padding * 2) / depth,
    )
    room_width, room_height = width * scale, depth * scale
    room_x, room_y = (
        (canvas_width - room_width) / 2,
        (canvas_height - room_height) / 2,
    )
    nodes = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="760" height="520" '
        'viewBox="0 0 760 520">',
        '<rect width="760" height="520" fill="#F7F8FA"/>',
        f'<text x="28" y="30" font-family="sans-serif" font-size="15" '
        f'fill="#536274">{html.escape(strategy)}</text>',
        f'<rect x="{room_x:.1f}" y="{room_y:.1f}" width="{room_width:.1f}" '
        f'height="{room_height:.1f}" fill="#FFFFFF" stroke="#183B56" stroke-width="5"/>',
    ]
    for placement in placements:
        x = room_x + placement["xMm"] * scale
        y = room_y + (depth - placement["yMm"] - placement["depthMm"]) * scale
        item_width = placement["widthMm"] * scale
        item_height = placement["depthMm"] * scale
        category = placement["category"]
        nodes.extend(
            [
                f'<rect x="{x:.1f}" y="{y:.1f}" width="{item_width:.1f}" '
                f'height="{item_height:.1f}" rx="8" '
                f'fill="{COLORS.get(category, "#AAB7C4")}" stroke="#FFFFFF" '
                'stroke-width="2"/>',
                f'<text x="{x + item_width / 2:.1f}" y="{y + item_height / 2 + 5:.1f}" '
                'text-anchor="middle" font-family="sans-serif" font-size="13" '
                f'fill="#102A43">{html.escape(category)}</text>',
            ]
        )
    nodes.append("</svg>")
    path.write_text("\n".join(nodes), encoding="utf-8")


def run_layout(payload: dict[str, Any]) -> dict[str, Any]:
    layouts = []
    for variant in range(payload.get("count", 2)):
        placements = _placements(payload, variant)
        violations = _validate(
            placements,
            payload["width_mm"],
            payload["depth_mm"],
        )
        if violations:
            if variant == 0:
                raise ProcessorError("SOLVER_NO_SOLUTION", "；".join(violations))
            continue
        strategy = "动线优先" if variant == 0 else "空间利用优先"
        preview = artifact_path(f"layout-{variant + 1}", ".svg")
        _svg(
            preview,
            placements,
            payload["width_mm"],
            payload["depth_mm"],
            strategy,
        )
        layouts.append(
            {
                "layoutId": f"layout_demo_{variant + 1}",
                "layoutVersion": 1,
                "strategy": "circulation_first"
                if variant == 0
                else "space_utilization",
                "placements": placements,
                "hardViolations": [],
                "metrics": {
                    "requirementCoverage": 1.0,
                    "minimumClearanceMm": 600 if variant == 0 else 450,
                    "usableAreaRatio": round(
                        sum(
                            item["widthMm"] * item["depthMm"]
                            for item in placements
                        )
                        / (payload["width_mm"] * payload["depth_mm"]),
                        3,
                    ),
                },
                "previewUrl": artifact_url(preview),
            }
        )
    if not layouts:
        raise ProcessorError("SOLVER_NO_SOLUTION", "未找到满足硬约束的家具布局")
    return {"layouts": layouts, "count": len(layouts)}


def _ai_layout_output_size(width_mm: int, depth_mm: int) -> tuple[str, int, int]:
    ratio = width_mm / depth_mm
    if ratio >= 1.15:
        return "1536x1024", 1536, 1024
    if ratio <= 1 / 1.15:
        return "1024x1536", 1024, 1536
    return "1024x1024", 1024, 1024


def _blank_structure_base(
    *,
    width_mm: int,
    depth_mm: int,
    room_type: str,
) -> Path:
    _, canvas_width, canvas_height = _ai_layout_output_size(width_mm, depth_mm)
    canvas = np.full((canvas_height, canvas_width, 3), 248, dtype=np.uint8)
    padding = round(min(canvas_width, canvas_height) * 0.12)
    scale = min(
        (canvas_width - padding * 2) / width_mm,
        (canvas_height - padding * 2) / depth_mm,
    )
    room_width = max(1, round(width_mm * scale))
    room_depth = max(1, round(depth_mm * scale))
    left = (canvas_width - room_width) // 2
    top = (canvas_height - room_depth) // 2
    right = left + room_width
    bottom = top + room_depth
    cv2.rectangle(canvas, (left, top), (right, bottom), (255, 255, 255), -1)
    cv2.rectangle(canvas, (left, top), (right, bottom), (34, 58, 76), 10)
    output = artifact_path("layout-ai-structure", ".png")
    if not cv2.imwrite(str(output), canvas):
        raise ProcessorError("GENERATION_FAILED", "AI 布局结构底图写入失败")
    return output


def _ai_layout_prompt(payload: dict[str, Any], *, variant: int) -> str:
    room_type = str(payload["room_type"])
    width_mm = int(payload["width_mm"])
    depth_mm = int(payload["depth_mm"])
    source_mode = "uploaded floor plan" if payload.get("source_path") else "generated rectangle"
    strategy = "circulation clarity and generous clearances" if variant == 0 else (
        "space utilization and additional functional storage"
    )
    user_requirement = str(payload.get("design_prompt") or "").strip()
    whole_home_rule = (
        "You may propose sensible internal room partitions inside the locked outer boundary."
        if room_type == "whole_home" and not payload.get("source_path")
        else "Do not add, remove or move any wall, opening or room boundary from input image 1."
    )
    return (
        "Create a polished, professional top-down 2D residential floor-plan layout, not a 3D "
        "perspective and not an interior photograph. INPUT ROLE LOCK: image 1 is the sole geometric "
        f"authority ({source_mode}), representing {width_mm} x {depth_mm} mm. Preserve its exact "
        "outer contour, aspect ratio, orientation and all visible structural geometry. "
        f"{whole_home_rule} All images after image 1 are reference examples only: use them solely for "
        "graphic style, furniture-symbol quality and layout-organization ideas. Never copy their "
        "walls, dimensions, room count, doors, windows or furniture coordinates. Arrange correctly "
        f"scaled furniture for a {AI_LAYOUT_ROOM_NAMES[room_type]}; variant {variant + 1} prioritizes "
        f"{strategy}. Keep circulation practical, furniture collision-free and all assets inside "
        "the authoritative boundary. Use crisp architectural linework, readable zoning and a clean "
        "white background. Do not crop the complete plan. Do not draw numerical dimensions, scale "
        "bars, construction annotations or claims that the result is build-ready; the requested "
        "size is planning metadata, not a measurable output scale. "
        f"Additional design requirement: {user_requirement or 'none; use a restrained modern layout.'}"
    )


def resolve_ai_layout_template_ids(value: Any) -> list[str]:
    if value is None:
        template_ids = list(AI_LAYOUT_TEMPLATES)
    elif isinstance(value, str):
        template_ids = [item.strip() for item in value.split(",") if item.strip()]
    elif isinstance(value, list):
        template_ids = [str(item).strip() for item in value if str(item).strip()]
    else:
        template_ids = []
    template_ids = list(dict.fromkeys(template_ids))
    invalid = [item for item in template_ids if item not in AI_LAYOUT_TEMPLATES]
    if invalid:
        raise ProcessorError(
            "INPUT_REJECTED",
            f"未知的 AI 布局模板：{', '.join(invalid)}",
        )
    if not template_ids:
        raise ProcessorError("INPUT_REJECTED", "至少需要一个有效的 AI 布局模板")
    return template_ids


def run_ai_layout(payload: dict[str, Any]) -> dict[str, Any]:
    if not settings.kuyao_image_edit_configured:
        raise ProcessorError(
            "AI_LAYOUT_UNAVAILABLE",
            "未配置 gpt-image-2 图像服务，无法生成 AI 平面布局",
        )
    template_ids = resolve_ai_layout_template_ids(payload.get("template_ids"))
    reference_paths = [AI_LAYOUT_TEMPLATES[template_id] for template_id in template_ids]
    missing_references = [path.name for path in reference_paths if not path.is_file()]
    if missing_references:
        raise ProcessorError(
            "AI_LAYOUT_REFERENCE_MISSING",
            f"缺少内置布局参考图：{', '.join(missing_references)}",
        )

    source_path = Path(payload["source_path"]) if payload.get("source_path") else None
    source_mode = "uploaded" if source_path is not None else "generated_rectangle"
    if source_path is None:
        source_path = _blank_structure_base(
            width_mm=int(payload["width_mm"]),
            depth_mm=int(payload["depth_mm"]),
            room_type=str(payload["room_type"]),
        )
    elif not source_path.is_file():
        raise ProcessorError("INPUT_REJECTED", "上传的平面结构图不存在")

    size, _, _ = _ai_layout_output_size(
        int(payload["width_mm"]),
        int(payload["depth_mm"]),
    )
    layouts = []
    for variant in range(int(payload.get("count", 1))):
        generated = edit_floorplan_image(
            source_path,
            api_key=settings.floorplan_vision_api_key,
            base_url=settings.kuyao_base_url,
            prompt=_ai_layout_prompt(payload, variant=variant),
            model=settings.kuyao_image_model,
            size=size,
            quality=settings.kuyao_image_quality,
            timeout_seconds=settings.kuyao_image_timeout_seconds,
            reference_paths=reference_paths,
        )
        notice = (
            "AI 布局仅为概念设计建议，当前未自动保证输入结构与输出结构完全一致；"
            "输出图片不可直接量测，结构、尺寸、消防与人体工学必须人工复核。"
        )
        structure_audit = {
            "performed": False,
            "geometryGuaranteed": False,
            "notice": "当前版本尚未执行基础墙线或边缘保留审计。",
        }
        layouts.append(
            {
                "layoutId": f"layout_ai_{variant + 1}",
                "layoutVersion": 1,
                "strategy": "circulation_first" if variant == 0 else "space_utilization",
                "previewUrl": generated["url"],
                "generationMode": "ai_image",
                "provider": generated["provider"],
                "model": generated["model"],
                "notice": notice,
                "isConceptOnly": True,
                "constructionReady": False,
                "requiresUserConfirmation": True,
                "templateIds": template_ids,
                "templateVersion": AI_LAYOUT_TEMPLATE_VERSION,
                "promptVersion": AI_LAYOUT_PROMPT_VERSION,
                "inputRoles": {
                    "image1": "geometry_authority",
                    "referenceImages": "inspiration_only",
                },
                "structureAudit": structure_audit,
            }
        )

    return {
        "layouts": layouts,
        "count": len(layouts),
        "generationMode": "ai_image",
        "provider": layouts[0]["provider"],
        "model": layouts[0]["model"],
        "notice": layouts[0]["notice"],
        "sourceMode": source_mode,
        "isConceptOnly": True,
        "constructionReady": False,
        "requiresUserConfirmation": True,
        "templateIds": template_ids,
        "templateVersion": AI_LAYOUT_TEMPLATE_VERSION,
        "promptVersion": AI_LAYOUT_PROMPT_VERSION,
        "inputRoles": {
            "image1": "geometry_authority",
            "referenceImages": "inspiration_only",
        },
        "structureAudit": layouts[0]["structureAudit"],
    }
