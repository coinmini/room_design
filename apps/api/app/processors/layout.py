from __future__ import annotations

import hashlib
import html
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from shapely.geometry import box

from app.config import settings
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

AI_LAYOUT_PROMPT_VERSION = "ai-professional-plan-v3-stage01-only"
AI_LAYOUT_ROOM_NAMES = {
    "whole_home": "whole residential home",
    "living_room": "living room",
    "dining_room": "dining room",
    "bedroom": "bedroom",
}

MAX_SEMANTIC_ROOMS = 40
MAX_SEMANTIC_WALLS = 180
MAX_SEMANTIC_OPENINGS = 100
MAX_SEMANTIC_FURNITURE = 240


def _as_mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _semantic_layout_value(payload: dict[str, Any]) -> dict[str, Any]:
    value = _as_mapping(payload.get("semantic_layout"))
    rooms = value.get("rooms")
    return value if isinstance(rooms, list) and rooms else {}


def _compact_items(
    items: Any,
    keys: tuple[str, ...],
    limit: int,
) -> list[dict[str, Any]]:
    compact: list[dict[str, Any]] = []
    for item in _as_list(items)[:limit]:
        if not isinstance(item, dict):
            continue
        value = {key: item[key] for key in keys if key in item}
        if value:
            compact.append(value)
    return compact


def _semantic_structure_lock(layout: dict[str, Any]) -> dict[str, Any]:
    """Return only confirmed Stage 01 structure, keeping furniture out of the lock."""

    return {
        "version": layout.get("version"),
        "profileId": layout.get("profileId"),
        "coordinateSystem": layout.get("coordinateSystem"),
        "plan": layout.get("plan"),
        "rooms": _compact_items(
            layout.get("rooms"),
            ("id", "type", "name", "rect", "polygon"),
            MAX_SEMANTIC_ROOMS,
        ),
        "walls": _compact_items(
            layout.get("walls"),
            ("id", "kind", "start", "end", "thicknessMm", "roomIds"),
            MAX_SEMANTIC_WALLS,
        ),
        "openings": _compact_items(
            layout.get("openings"),
            (
                "id",
                "type",
                "wallId",
                "wallAxis",
                "segment",
                "center",
                "widthMm",
                "heightMm",
                "sillHeightMm",
                "swing",
                "roomIds",
            ),
            MAX_SEMANTIC_OPENINGS,
        ),
    }


def _semantic_furniture_reference(layout: dict[str, Any]) -> list[dict[str, Any]]:
    return _compact_items(
        layout.get("furniture"),
        ("id", "type", "roomId", "center", "size", "rotationDeg"),
        MAX_SEMANTIC_FURNITURE,
    )


def _semantic_digest(layout: dict[str, Any]) -> str:
    encoded = json.dumps(
        layout,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _semantic_input_summary(layout: dict[str, Any]) -> dict[str, Any]:
    if not layout:
        return {}
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
        "authoritativeSections": ["plan", "rooms", "walls", "openings"],
        "furnitureRole": "current_state_reference_only",
    }


def _semantic_lock_prompt(layout: dict[str, Any]) -> str:
    if not layout:
        return ""
    structure = json.dumps(
        _semantic_structure_lock(layout),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    furniture = json.dumps(
        _semantic_furniture_reference(layout),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return (
        " STAGE 01 CONFIRMED SEMANTIC STRUCTURE LOCK: plan, rooms, walls and openings in "
        "the following semanticLayout JSON are authoritative. Preserve their topology, count, "
        "coordinates, dimensions and relationships; never mirror, rotate, merge, delete or invent "
        f"them. STRUCTURE JSON: {structure} "
        "FURNITURE ROLE: the following furniture JSON describes the current-state plan only and is "
        "not structurally locked. Use it as an advisory reference; furniture may be rearranged or "
        f"replaced to satisfy the new layout brief while keeping circulation valid: {furniture}"
    )


ROOM_CONTROL_LABELS = {
    "living_room": "LIVING",
    "dining_room": "DINING",
    "living_dining": "LIVING DINING",
    "bedroom": "BEDROOM",
    "master_bedroom": "MASTER BED",
    "kitchen": "KITCHEN",
    "bathroom": "BATHROOM",
    "courtyard": "COURTYARD",
    "yard": "COURTYARD",
    "garage": "GARAGE",
    "balcony": "BALCONY",
    "entrance": "ENTRANCE",
    "corridor": "CORRIDOR",
    "study": "STUDY",
    "storage": "STORAGE",
}

ROOM_CONTROL_COLORS = (
    (210, 232, 255),
    (218, 242, 224),
    (246, 228, 214),
    (232, 222, 248),
    (220, 238, 242),
    (240, 235, 210),
)


def _stage01_image_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _room_control_polygon(room: dict[str, Any]) -> list[dict[str, float]]:
    polygon = room.get("polygon")
    if isinstance(polygon, list) and len(polygon) >= 3:
        points = [point for point in polygon if isinstance(point, dict)]
        if len(points) >= 3:
            return points
    rect = room.get("rect")
    if not isinstance(rect, dict):
        return []
    try:
        x = float(rect["xMm"])
        y = float(rect["yMm"])
        width = float(rect["widthMm"])
        depth = float(rect["depthMm"])
    except (KeyError, TypeError, ValueError):
        return []
    return [
        {"xMm": x, "yMm": y},
        {"xMm": x + width, "yMm": y},
        {"xMm": x + width, "yMm": y + depth},
        {"xMm": x, "yMm": y + depth},
    ]


def _opening_control_segment(
    opening: dict[str, Any],
) -> tuple[dict[str, float], dict[str, float]] | None:
    segment = _as_mapping(opening.get("segment"))
    start = _as_mapping(segment.get("start"))
    end = _as_mapping(segment.get("end"))
    if start and end:
        return start, end

    center = _as_mapping(opening.get("center"))
    try:
        center_x = float(center["xMm"])
        center_y = float(center["yMm"])
        half_width = float(opening["widthMm"]) / 2
    except (KeyError, TypeError, ValueError):
        return None
    if half_width <= 0:
        return None
    if str(opening.get("wallAxis") or "").lower() == "vertical":
        return (
            {"xMm": center_x, "yMm": center_y - half_width},
            {"xMm": center_x, "yMm": center_y + half_width},
        )
    return (
        {"xMm": center_x - half_width, "yMm": center_y},
        {"xMm": center_x + half_width, "yMm": center_y},
    )


def _stage01_control_image(
    source_path: Path,
    semantic_layout: dict[str, Any],
    raw_bounds: Any,
) -> Path:
    source = cv2.imread(str(source_path), cv2.IMREAD_COLOR)
    if source is None:
        raise ProcessorError("INPUT_REJECTED", "Stage 01 原图无法读取")
    image_height, image_width = source.shape[:2]
    plan = _as_mapping(semantic_layout.get("plan"))
    plan_width = float(plan.get("widthMm") or 0)
    plan_depth = float(plan.get("depthMm") or 0)
    if plan_width <= 0 or plan_depth <= 0:
        raise ProcessorError("INPUT_REJECTED", "Stage 01 缺少有效的平面尺寸")

    bounds = _as_mapping(raw_bounds)
    left = max(0.0, min(float(bounds.get("x") or 0), image_width - 1))
    top = max(0.0, min(float(bounds.get("y") or 0), image_height - 1))
    width = max(1.0, min(float(bounds.get("width") or image_width), image_width - left))
    height = max(1.0, min(float(bounds.get("height") or image_height), image_height - top))

    def pixel(point: dict[str, Any]) -> tuple[int, int]:
        x_mm = float(point.get("xMm") or 0)
        y_mm = float(point.get("yMm") or 0)
        return (
            round(left + x_mm / plan_width * width),
            round(top + y_mm / plan_depth * height),
        )

    control = source.copy()
    zone_layer = source.copy()
    room_shapes: list[tuple[dict[str, Any], np.ndarray]] = []
    for index, room in enumerate(_as_list(semantic_layout.get("rooms"))):
        if not isinstance(room, dict):
            continue
        polygon = _room_control_polygon(room)
        if len(polygon) < 3:
            continue
        shape = np.array([pixel(point) for point in polygon], dtype=np.int32)
        room_shapes.append((room, shape))
        cv2.fillPoly(zone_layer, [shape], ROOM_CONTROL_COLORS[index % len(ROOM_CONTROL_COLORS)])
    control = cv2.addWeighted(zone_layer, 0.22, control, 0.78, 0)

    wall_thickness = max(2, round(min(image_width, image_height) / 420))
    for wall in _as_list(semantic_layout.get("walls")):
        if not isinstance(wall, dict):
            continue
        start = wall.get("start")
        end = wall.get("end")
        if not isinstance(start, dict) or not isinstance(end, dict):
            continue
        cv2.line(control, pixel(start), pixel(end), (24, 24, 24), wall_thickness)

    opening_thickness = max(3, wall_thickness + 1)
    for opening in _as_list(semantic_layout.get("openings")):
        if not isinstance(opening, dict):
            continue
        segment = _opening_control_segment(opening)
        if segment is None:
            continue
        start, end = (pixel(point) for point in segment)
        # Cut the confirmed opening through the wall overlay, then mark its
        # type. This keeps manually corrected doors/windows visible even when
        # the source drawing still contains an outdated opening.
        cv2.line(
            control,
            start,
            end,
            (255, 255, 255),
            opening_thickness + 4,
            cv2.LINE_AA,
        )
        opening_type = str(opening.get("type") or "opening").lower()
        color = (42, 128, 232) if opening_type == "door" else (214, 154, 48)
        cv2.line(
            control,
            start,
            end,
            color,
            opening_thickness,
            cv2.LINE_AA,
        )

    font_scale = max(0.38, min(0.9, min(image_width, image_height) / 1100))
    font_thickness = max(1, round(font_scale * 2))
    for index, (room, shape) in enumerate(room_shapes):
        moments = cv2.moments(shape)
        if moments["m00"]:
            center = (
                round(moments["m10"] / moments["m00"]),
                round(moments["m01"] / moments["m00"]),
            )
        else:
            center = tuple(np.mean(shape, axis=0).astype(int))
        room_type = str(room.get("type") or "").strip().lower()
        label = ROOM_CONTROL_LABELS.get(room_type, room_type.replace("_", " ").upper())
        label = f"R{index + 1:02d} {label or 'ROOM'}"
        (text_width, text_height), baseline = cv2.getTextSize(
            label,
            cv2.FONT_HERSHEY_SIMPLEX,
            font_scale,
            font_thickness,
        )
        origin = (center[0] - text_width // 2, center[1] + text_height // 2)
        cv2.rectangle(
            control,
            (origin[0] - 5, origin[1] - text_height - 5),
            (origin[0] + text_width + 5, origin[1] + baseline + 5),
            (255, 255, 255),
            -1,
        )
        cv2.putText(
            control,
            label,
            origin,
            cv2.FONT_HERSHEY_SIMPLEX,
            font_scale,
            (51, 83, 208),
            font_thickness,
            cv2.LINE_AA,
        )

    output = artifact_path("layout-ai-stage01-control", ".png")
    if not cv2.imwrite(str(output), control):
        raise ProcessorError("GENERATION_FAILED", "Stage 01 功能区控制图写入失败")
    return output


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


def _ai_layout_prompt(payload: dict[str, Any], *, variant: int) -> str:
    room_type = str(payload["room_type"])
    width_mm = int(payload["width_mm"])
    depth_mm = int(payload["depth_mm"])
    semantic_layout = _semantic_layout_value(payload)
    source_mode = (
        "confirmed Stage 01 project image with function-zone overlay"
        if semantic_layout
        else "uploaded project image"
    )
    strategy = "circulation clarity and generous clearances" if variant == 0 else (
        "space utilization and additional functional storage"
    )
    user_requirement = str(payload.get("design_prompt") or "").strip()
    if semantic_layout:
        whole_home_rule = (
            "Do not add, remove or move any wall, opening or room boundary outside the confirmed "
            "Stage 01 semantic structure lock."
        )
    elif room_type == "whole_home" and not payload.get("source_path"):
        whole_home_rule = (
            "You may propose sensible internal room partitions inside the locked outer boundary."
        )
    else:
        whole_home_rule = (
            "Do not add, remove or move any wall, opening or room boundary from input image 1."
        )
    image_authority = (
        "image 1 and the confirmed semantic JSON jointly are the sole project authority"
        if semantic_layout
        else "image 1 is the sole project authority"
    )
    return (
        "Convert the current project's confirmed Stage 01 function-zone annotation into a polished, "
        "professional black-and-white top-down architectural floor-plan drawing. This is the same "
        "project and the same floor plan: do not create an alternative apartment concept, do not use "
        "or imitate another completed floor-plan template, and do not output a 3D perspective or an "
        f"interior photograph. INPUT ROLE LOCK: {image_authority} ({source_mode}), representing "
        f"{width_mm} x {depth_mm} mm. Preserve its exact outer footprint, aspect ratio, orientation, "
        "courtyards, garage, room count, function names, room positions, adjacency, walls, doors, "
        f"windows and entrances. {whole_home_rule}{_semantic_lock_prompt(semantic_layout)} "
        "In image 1, orange-red opening segments mark confirmed doors and blue-cyan segments mark "
        "confirmed windows; retain every marked opening at that exact wall position. "
        "Professionalize the confirmed annotation by adding correctly scaled furniture, sanitary "
        "fixtures, kitchen cabinetry, storage, landscape planting and paving only inside their "
        f"corresponding functional zones. Variant {variant + 1} prioritizes {strategy}. Keep "
        "circulation practical, furniture collision-free and every object inside its assigned room. "
        "Use crisp black architectural line weights, clear door swings, restrained gray hatching, "
        "readable room labels and a clean white background. Preserve special outdoor functions such "
        "as courtyard and garage instead of converting them into ordinary indoor rooms. Do not crop, "
        "mirror or rotate the complete plan. Do not draw numerical dimensions, scale bars, "
        "construction annotations or claims that the result is build-ready; the requested size is "
        "planning metadata, not a measurable output scale. No external floor-plan reference images "
        "are supplied or permitted. "
        f"Additional design requirement: {user_requirement or 'none; use a restrained modern layout.'}"
    )


def run_ai_layout(payload: dict[str, Any]) -> dict[str, Any]:
    if not settings.kuyao_image_edit_configured:
        raise ProcessorError(
            "AI_LAYOUT_UNAVAILABLE",
            "未配置 gpt-image-2 图像服务，无法生成 AI 平面布局",
        )
    semantic_layout = _semantic_layout_value(payload)
    semantic_summary = _semantic_input_summary(semantic_layout)

    source_path = Path(str(payload.get("source_path") or ""))
    if not source_path.is_file():
        raise ProcessorError("INPUT_REJECTED", "Stage 01 已批准原图不存在")
    if not semantic_layout:
        raise ProcessorError("INPUT_REJECTED", "Stage 01 SemanticLayout 不能为空")
    semantic_source_sha256 = str(semantic_layout.get("sourceSha256") or "").strip()
    submitted_source_sha256 = str(payload.get("stage01_source_sha256") or "").strip()
    if not semantic_source_sha256:
        raise ProcessorError("INPUT_REJECTED", "Stage 01 SemanticLayout 缺少原图摘要")
    if submitted_source_sha256 != semantic_source_sha256:
        raise ProcessorError("INPUT_REJECTED", "Stage 01 批准语义与原图摘要不一致")
    source_sha256 = _stage01_image_sha256(source_path)
    if source_sha256 != semantic_source_sha256:
        raise ProcessorError("INPUT_REJECTED", "Stage 01 原图与批准语义的来源摘要不一致")
    model_source_path = _stage01_control_image(
        source_path,
        semantic_layout,
        payload.get("stage01_detected_bounds"),
    )
    source_mode = "stage01_confirmed_annotation"

    size, _, _ = _ai_layout_output_size(
        int(payload["width_mm"]),
        int(payload["depth_mm"]),
    )
    layouts = []
    for variant in range(int(payload.get("count", 1))):
        generated = edit_floorplan_image(
            model_source_path,
            api_key=settings.floorplan_vision_api_key,
            base_url=settings.kuyao_base_url,
            prompt=_ai_layout_prompt(payload, variant=variant),
            model=settings.kuyao_image_model,
            size=size,
            quality=settings.kuyao_image_quality,
            timeout_seconds=settings.kuyao_image_timeout_seconds,
        )
        notice = (
            "AI 生成的专业平面布局仍属于方案设计，当前未自动保证输入结构与输出结构完全一致；"
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
                "promptVersion": AI_LAYOUT_PROMPT_VERSION,
                "generationGoal": "professional_black_white_floor_plan",
                "referencePolicy": "stage01_only",
                "referenceImageCount": 0,
                "inputRoles": {
                    "image1": "stage01_annotated_project_authority",
                    "referenceImages": "none",
                    "semanticLayout": "confirmed_function_zone_and_structure_authority",
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
        "approvalStatus": "review_required",
        "promptVersion": AI_LAYOUT_PROMPT_VERSION,
        "generationGoal": "professional_black_white_floor_plan",
        "referencePolicy": "stage01_only",
        "referenceImageCount": 0,
        "inputRoles": {
            "image1": "stage01_annotated_project_authority",
            "referenceImages": "none",
            "semanticLayout": "confirmed_function_zone_and_structure_authority",
        },
        "semanticInput": semantic_summary,
        "structureAudit": layouts[0]["structureAudit"],
        "stage01ControlImageUrl": artifact_url(model_source_path),
        "stage01Lineage": {
            "analysisJobId": payload.get("stage01_analysis_job_id"),
            "approvedVersionId": payload.get("stage01_approved_version_id"),
            "sourceSha256": source_sha256,
        },
    }
