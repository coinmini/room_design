from __future__ import annotations

import html
from pathlib import Path
from typing import Any

from shapely.geometry import box

from app.processors.common import ProcessorError
from app.storage import artifact_path, artifact_url


COLORS = {
    "sofa": "#78A6D1",
    "coffee_table": "#D9B779",
    "tv_console": "#8090A0",
    "dining_table": "#C99472",
    "bed": "#83B6A4",
    "wardrobe": "#9C91BF",
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

