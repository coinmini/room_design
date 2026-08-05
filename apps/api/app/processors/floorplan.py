from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
from time import perf_counter
from typing import Any

import cv2
import numpy as np
from shapely import affinity
from shapely.errors import GEOSException
from shapely.geometry import LineString, Polygon, box
from shapely.ops import polygonize, unary_union

from app.config import settings
from app.processors.blender import render_floorplan_with_blender
from app.processors.common import ProcessorError
from app.processors.floorplan_enhancement import (
    edge_control,
    enhance_floorplan_render,
    generate_direct_floorplan_render,
)
from app.processors.floorplan_semantic import compile_semantic_layout
from app.processors.floorplan_vision import recognize_floorplan
from app.processors.image import read_image, write_image
from app.storage import artifact_path, artifact_url


MODEL_CAMERA_PRESETS = [
    {"id": "dollhouse", "name": "全屋鸟瞰", "projection": "orthographic"},
    {"id": "topdown", "name": "正交俯视", "projection": "orthographic"},
    {"id": "corner_01", "name": "右前角", "projection": "perspective"},
    {"id": "corner_02", "name": "左前角", "projection": "perspective"},
    {"id": "eye_level_01", "name": "1.6 米平视", "projection": "perspective"},
]
MODEL_MATERIAL_PRESETS = [
    {
        "id": "modern_warm_v1",
        "name": "现代暖调",
        "groups": ["wall", "floor", "woodwork", "fabric"],
    },
    {
        "id": "modern_minimal_v1",
        "name": "现代极简",
        "groups": ["wall", "floor", "woodwork", "fabric"],
    },
    {
        "id": "natural_wood_v1",
        "name": "自然原木",
        "groups": ["wall", "floor", "woodwork", "fabric"],
    },
]


def _model_delivery(
    generation_mode: str,
    provider: str,
    canonical_render_path: Path,
) -> dict[str, Any]:
    if generation_mode == "ai_direct":
        return {
            "editable": False,
            "blendUrl": None,
            "glbUrl": None,
            "cameraPresets": [],
            "materialPresets": [],
            "canonicalView": None,
            "notice": "AI 直出是二维视觉资产，不包含可编辑三维模型。",
        }

    blend_path = canonical_render_path.with_suffix(".blend")
    glb_path = canonical_render_path.with_suffix(".glb")
    is_blender_scene = provider == "blender-floorplan-headless"
    blend_url = (
        artifact_url(blend_path)
        if is_blender_scene and blend_path.is_file()
        else None
    )
    glb_url = (
        artifact_url(glb_path)
        if is_blender_scene and glb_path.is_file()
        else None
    )
    editable = blend_url is not None
    if not editable:
        notice = "本次未生成 Blender 场景；请启用 Blender 并使用基础或最终质量重新生成。"
    elif glb_url is None:
        notice = "可编辑 .blend 已保存；GLB 导出失败，但不影响图片和 Blender 场景交付。"
    else:
        notice = "已保存可编辑 .blend 与网页预览 GLB，可用于多机位、材质替换和后续三维交付。"
    return {
        "editable": editable,
        "blendUrl": blend_url,
        "glbUrl": glb_url,
        "cameraPresets": MODEL_CAMERA_PRESETS if editable else [],
        "materialPresets": MODEL_MATERIAL_PRESETS if editable else [],
        "canonicalView": "dollhouse",
        "notice": notice,
    }


def _orientation(line: tuple[int, int, int, int]) -> str | None:
    x1, y1, x2, y2 = line
    dx = abs(x2 - x1)
    dy = abs(y2 - y1)
    if dx >= max(12, dy * 8):
        return "horizontal"
    if dy >= max(12, dx * 8):
        return "vertical"
    return None


def _normalized_line(
    line: tuple[int, int, int, int],
    orientation: str,
) -> dict[str, float | str]:
    x1, y1, x2, y2 = line
    if orientation == "horizontal":
        return {
            "orientation": orientation,
            "coordinate": round((y1 + y2) / 2),
            "start": min(x1, x2),
            "end": max(x1, x2),
        }
    return {
        "orientation": orientation,
        "coordinate": round((x1 + x2) / 2),
        "start": min(y1, y2),
        "end": max(y1, y2),
    }


def _merge_collinear(
    lines: list[dict[str, float | str]],
    *,
    coordinate_tolerance: int = 5,
    gap_tolerance: int = 14,
) -> list[dict[str, float | str]]:
    merged: list[dict[str, float | str]] = []
    for orientation in ("horizontal", "vertical"):
        values = sorted(
            (item for item in lines if item["orientation"] == orientation),
            key=lambda item: (float(item["coordinate"]), float(item["start"])),
        )
        groups: list[list[dict[str, float | str]]] = []
        for item in values:
            target = next(
                (
                    group
                    for group in groups
                    if abs(
                        np.mean([float(value["coordinate"]) for value in group])
                        - float(item["coordinate"])
                    )
                    <= coordinate_tolerance
                ),
                None,
            )
            if target is None:
                groups.append([item])
            else:
                target.append(item)

        for group in groups:
            coordinate = round(np.mean([float(item["coordinate"]) for item in group]))
            intervals = sorted((float(item["start"]), float(item["end"])) for item in group)
            start, end = intervals[0]
            for next_start, next_end in intervals[1:]:
                if next_start <= end + gap_tolerance:
                    end = max(end, next_end)
                else:
                    merged.append(
                        {
                            "orientation": orientation,
                            "coordinate": coordinate,
                            "start": round(start),
                            "end": round(end),
                        }
                    )
                    start, end = next_start, next_end
            merged.append(
                {
                    "orientation": orientation,
                    "coordinate": coordinate,
                    "start": round(start),
                    "end": round(end),
                }
            )
    return merged


def _structural_bounds(
    gray: np.ndarray,
    image_width: int,
    image_height: int,
) -> dict[str, int]:
    _, binary = cv2.threshold(gray, 180, 255, cv2.THRESH_BINARY_INV)
    contours, _ = cv2.findContours(
        binary,
        cv2.RETR_LIST,
        cv2.CHAIN_APPROX_SIMPLE,
    )
    image_area = image_width * image_height
    for contour in sorted(contours, key=cv2.contourArea, reverse=True):
        x, y, width, height = cv2.boundingRect(contour)
        if (
            cv2.contourArea(contour) >= image_area * 0.25
            and width >= image_width * 0.45
            and height >= image_height * 0.45
        ):
            return {
                "x": x,
                "y": y,
                "width": width,
                "height": height,
            }

    return {
        "x": round(image_width * 0.04),
        "y": round(image_height * 0.04),
        "width": round(image_width * 0.92),
        "height": round(image_height * 0.92),
    }


def _line_points(
    item: dict[str, float | str],
) -> tuple[int, int, int, int]:
    if item["orientation"] == "horizontal":
        return (
            round(float(item["start"])),
            round(float(item["coordinate"])),
            round(float(item["end"])),
            round(float(item["coordinate"])),
        )
    return (
        round(float(item["coordinate"])),
        round(float(item["start"])),
        round(float(item["coordinate"])),
        round(float(item["end"])),
    )


def _black_density(
    gray: np.ndarray,
    points: tuple[int, int, int, int],
) -> float:
    x1, y1, x2, y2 = points
    height, width = gray.shape
    if abs(x2 - x1) >= abs(y2 - y1):
        y_start, y_end = max(0, y1 - 3), min(height, y1 + 4)
        x_start, x_end = max(0, min(x1, x2)), min(width, max(x1, x2) + 1)
    else:
        x_start, x_end = max(0, x1 - 3), min(width, x1 + 4)
        y_start, y_end = max(0, min(y1, y2)), min(height, max(y1, y2) + 1)
    region = gray[y_start:y_end, x_start:x_end]
    return float(np.mean(region < 175)) if region.size else 0.0


def _collapse_parallel_edges(walls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Turn the two visible edges of a thick wall into one editable centerline."""
    remaining = sorted(
        walls,
        key=lambda item: (
            item["orientation"],
            item["y1"] if item["orientation"] == "horizontal" else item["x1"],
        ),
    )
    collapsed: list[dict[str, Any]] = []
    used: set[int] = set()

    for index, wall in enumerate(remaining):
        if index in used:
            continue

        orientation = wall["orientation"]
        coordinate = wall["y1"] if orientation == "horizontal" else wall["x1"]
        start = wall["x1"] if orientation == "horizontal" else wall["y1"]
        end = wall["x2"] if orientation == "horizontal" else wall["y2"]
        best_match: tuple[int, dict[str, Any]] | None = None
        best_overlap = 0.0

        for match_index in range(index + 1, len(remaining)):
            if match_index in used:
                continue
            candidate = remaining[match_index]
            if candidate["orientation"] != orientation:
                break

            candidate_coordinate = (
                candidate["y1"] if orientation == "horizontal" else candidate["x1"]
            )
            gap = abs(candidate_coordinate - coordinate)
            if gap > 16:
                if candidate_coordinate > coordinate:
                    break
                continue

            candidate_start = candidate["x1"] if orientation == "horizontal" else candidate["y1"]
            candidate_end = candidate["x2"] if orientation == "horizontal" else candidate["y2"]
            overlap = max(0, min(end, candidate_end) - max(start, candidate_start))
            shorter_length = max(1, min(end - start, candidate_end - candidate_start))
            overlap_ratio = overlap / shorter_length
            if overlap_ratio >= 0.68 and overlap_ratio > best_overlap:
                best_overlap = overlap_ratio
                best_match = (match_index, candidate)

        if best_match is None:
            collapsed.append(wall)
            continue

        match_index, match = best_match
        used.add(match_index)
        match_coordinate = match["y1"] if orientation == "horizontal" else match["x1"]
        center_coordinate = int(round((coordinate + match_coordinate) / 2))
        match_start = match["x1"] if orientation == "horizontal" else match["y1"]
        match_end = match["x2"] if orientation == "horizontal" else match["y2"]

        if orientation == "horizontal":
            collapsed.append(
                {
                    **wall,
                    "x1": min(start, match_start),
                    "y1": center_coordinate,
                    "x2": max(end, match_end),
                    "y2": center_coordinate,
                    "thicknessPx": max(4, abs(coordinate - match_coordinate)),
                    "confidence": max(wall["confidence"], match["confidence"]),
                }
            )
        else:
            collapsed.append(
                {
                    **wall,
                    "x1": center_coordinate,
                    "y1": min(start, match_start),
                    "x2": center_coordinate,
                    "y2": max(end, match_end),
                    "thicknessPx": max(4, abs(coordinate - match_coordinate)),
                    "confidence": max(wall["confidence"], match["confidence"]),
                }
            )

    return collapsed


def _detect_walls(image: np.ndarray) -> tuple[dict[str, int], list[dict[str, Any]]]:
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(gray, 45, 135)
    raw = cv2.HoughLinesP(
        edges,
        1,
        np.pi / 180,
        threshold=max(28, round(min(width, height) * 0.045)),
        minLineLength=max(34, round(min(width, height) * 0.055)),
        maxLineGap=12,
    )
    if raw is None:
        raise ProcessorError("INPUT_REJECTED", "未检测到可用直墙候选")

    # OpenCV 可能返回 (N,1,4) 或 (N,4)；统一成 (N,4)，避免 raw[:,0] 变成标量列
    lines = np.asarray(raw).reshape(-1, 4)
    normalized = []
    for value in lines:
        line = tuple(int(item) for item in value)
        orientation = _orientation(line)
        if orientation:
            normalized.append(_normalized_line(line, orientation))

    merged = _merge_collinear(normalized)
    bounds = _structural_bounds(gray, width, height)
    padding = 12
    min_length = max(38, round(min(bounds["width"], bounds["height"]) * 0.065))
    filtered: list[dict[str, Any]] = []
    for item in merged:
        points = _line_points(item)
        x1, y1, x2, y2 = points
        length = math.hypot(x2 - x1, y2 - y1)
        if length < min_length:
            continue
        if not (
            bounds["x"] - padding <= min(x1, x2) <= bounds["x"] + bounds["width"] + padding
            and bounds["x"] - padding <= max(x1, x2) <= bounds["x"] + bounds["width"] + padding
            and bounds["y"] - padding <= min(y1, y2) <= bounds["y"] + bounds["height"] + padding
            and bounds["y"] - padding <= max(y1, y2) <= bounds["y"] + bounds["height"] + padding
        ):
            continue
        density = _black_density(gray, points)
        length_score = min(1.0, length / max(bounds["width"], bounds["height"]))
        confidence = min(0.99, 0.42 + length_score * 0.38 + density * 0.34)
        filtered.append(
            {
                "orientation": item["orientation"],
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2,
                "thicknessPx": max(2, min(8, round(2 + density * 5))),
                "confidence": round(confidence, 3),
                "source": "auto",
            }
        )

    filtered = _collapse_parallel_edges(filtered)
    filtered.sort(
        key=lambda item: (
            item["confidence"],
            math.hypot(item["x2"] - item["x1"], item["y2"] - item["y1"]),
        ),
        reverse=True,
    )
    filtered = filtered[:80]
    if len(filtered) < 4:
        raise ProcessorError("INPUT_REJECTED", "有效直墙候选少于 4 条")
    for index, item in enumerate(filtered, start=1):
        item["id"] = f"wall_auto_{index:03d}"
    return bounds, filtered


def _semantic_wall_candidates(
    semantic_layout: dict[str, Any],
    bounds: dict[str, int],
) -> list[dict[str, Any]]:
    """Project reviewed millimetre wall centerlines into source-image pixels."""
    plan = semantic_layout["plan"]
    width_mm = float(plan["widthMm"])
    depth_mm = float(plan["depthMm"])
    if width_mm <= 0 or depth_mm <= 0:
        raise ProcessorError("INPUT_REJECTED", "语义户型的平面尺寸无效")

    scale_x = bounds["width"] / width_mm
    scale_y = bounds["height"] / depth_mm
    candidates: list[dict[str, Any]] = []
    for wall in semantic_layout.get("walls", []):
        start = wall["start"]
        end = wall["end"]
        x1 = round(bounds["x"] + float(start["xMm"]) * scale_x)
        y1 = round(bounds["y"] + float(start["yMm"]) * scale_y)
        x2 = round(bounds["x"] + float(end["xMm"]) * scale_x)
        y2 = round(bounds["y"] + float(end["yMm"]) * scale_y)
        orientation = "horizontal" if abs(x2 - x1) >= abs(y2 - y1) else "vertical"
        thickness_mm = float(wall.get("thicknessMm", 100))
        thickness_px = round(thickness_mm * (scale_y if orientation == "horizontal" else scale_x))
        candidates.append(
            {
                "id": str(wall["id"]),
                "orientation": orientation,
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2,
                "thicknessPx": max(2, thickness_px),
                "confidence": round(float(wall.get("confidence", 1.0)), 3),
                "source": "semantic",
            }
        )
    if len(candidates) < 4:
        raise ProcessorError("INPUT_REJECTED", "语义户型的有效墙线少于 4 条")
    return candidates


def _analysis_overlay(
    source: np.ndarray,
    bounds: dict[str, int],
    walls: list[dict[str, Any]],
) -> Path:
    overlay = source.copy()
    for wall in walls:
        confidence = wall["confidence"]
        color = (
            (184, 87, 115)
            if wall.get("source") == "semantic"
            else (212, 132, 34)
            if confidence >= 0.7
            else (64, 164, 224)
        )
        cv2.line(
            overlay,
            (wall["x1"], wall["y1"]),
            (wall["x2"], wall["y2"]),
            color,
            2,
            cv2.LINE_AA,
        )
    cv2.rectangle(
        overlay,
        (bounds["x"], bounds["y"]),
        (bounds["x"] + bounds["width"], bounds["y"] + bounds["height"]),
        (76, 175, 80),
        3,
    )
    return write_image("floorplan-analysis-overlay", overlay)


def run_floorplan_analyze(payload: dict[str, Any]) -> dict[str, Any]:
    source = read_image(payload["source_path"])
    image_height, image_width = source.shape[:2]
    vision_result: dict[str, Any] | None = None
    recognition_mode = "geometric-fallback"
    if settings.floorplan_vision_configured:
        supplied_width = payload.get("plan_width_mm")
        supplied_depth = payload.get("plan_depth_mm")
        vision_result = recognize_floorplan(
            payload["source_path"],
            plan_width_mm=int(supplied_width) if supplied_width is not None else None,
            plan_depth_mm=int(supplied_depth) if supplied_depth is not None else None,
            source_image_width=image_width,
            source_image_height=image_height,
            api_key=settings.floorplan_vision_api_key,
            base_url=settings.kuyao_base_url,
            model=settings.kuyao_vision_model,
            timeout_seconds=settings.kuyao_vision_timeout_seconds,
        )
        semantic_layout = vision_result["semantic_layout"]
        drawing_bounds = vision_result["drawing_bounds"]
        bounds = {
            "x": round(float(drawing_bounds["xQ"]) / 10_000 * image_width),
            "y": round(float(drawing_bounds["yQ"]) / 10_000 * image_height),
            "width": max(
                1,
                round(float(drawing_bounds["widthQ"]) / 10_000 * image_width),
            ),
            "height": max(
                1,
                round(float(drawing_bounds["depthQ"]) / 10_000 * image_height),
            ),
        }
        recognition_mode = "external-vision"
    else:
        semantic_layout = compile_semantic_layout(payload["source_path"])
        if semantic_layout:
            recognition_mode = "reviewed-semantic-fixture"
    if semantic_layout:
        if vision_result is None:
            gray = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY)
            bounds = _structural_bounds(gray, image_width, image_height)
        walls = _semantic_wall_candidates(semantic_layout, bounds)
    else:
        bounds, walls = _detect_walls(source)
    overlay = _analysis_overlay(source, bounds, walls)
    if semantic_layout:
        plan_width = int(semantic_layout["plan"]["widthMm"])
        plan_depth = int(semantic_layout["plan"]["depthMm"])
    else:
        plan_width = payload.get("plan_width_mm")
        plan_depth = payload.get("plan_depth_mm")
        if not isinstance(plan_width, int) or not isinstance(plan_depth, int):
            raise ProcessorError(
                "INPUT_REJECTED",
                "无法自动识别总宽和总深，请手动填写物理尺寸后重试",
            )
    scale_x = plan_width / bounds["width"]
    scale_y = plan_depth / bounds["height"]
    delta = abs(scale_x - scale_y) / max(scale_x, scale_y)
    return {
        "schemaVersion": "0.5",
        "sourceImageUrl": artifact_url(payload["source_path"]),
        "overlayPreviewUrl": artifact_url(overlay),
        "imageWidth": image_width,
        "imageHeight": image_height,
        "planWidthMm": plan_width,
        "planDepthMm": plan_depth,
        "scaleX": round(scale_x, 4),
        "scaleY": round(scale_y, 4),
        "detectedBounds": bounds,
        "wallCandidates": walls,
        "semanticLayout": semantic_layout,
        "quality": {
            "candidateCount": len(walls),
            "orthogonalRatio": 1.0,
            "scaleDeltaRatio": round(delta, 4),
            "scaleWarning": delta > 0.05,
            "recognitionMode": recognition_mode,
            "visionConfigured": settings.floorplan_vision_configured,
            "provider": vision_result.get("provider") if vision_result else None,
            "model": vision_result.get("model") if vision_result else None,
            "cacheHit": vision_result.get("cache_hit", False) if vision_result else False,
            "confidence": vision_result.get("confidence") if vision_result else None,
            "dimensionSource": (
                vision_result.get("dimension_source") if vision_result else "semantic_fixture"
            ),
            "dimensionConfidence": (
                vision_result.get("dimension_confidence") if vision_result else 1.0
            ),
            "dimensionEvidence": (
                vision_result.get("dimension_evidence", []) if vision_result else []
            ),
            "warnings": vision_result.get("warnings", []) if vision_result else [],
            "semanticProfileId": (semantic_layout.get("profileId") if semantic_layout else None),
            "roomCount": len(semantic_layout.get("rooms", [])) if semantic_layout else 0,
            "openingCount": (len(semantic_layout.get("openings", [])) if semantic_layout else 0),
            "furnitureCount": (len(semantic_layout.get("furniture", [])) if semantic_layout else 0),
            "requiresUserConfirmation": True,
        },
    }


def _resolve_source(source_url: str) -> Path:
    name = Path(source_url).name
    path = settings.artifact_dir / name
    if not path.exists():
        raise ProcessorError("INPUT_REJECTED", "原始平面图文件不存在")
    return path


def _semantic_structure_status_unchecked(payload: dict[str, Any]) -> dict[str, Any]:
    layout = payload.get("semantic_layout")
    if not isinstance(layout, dict):
        return {
            "enabled": False,
            "passed": True,
            "version": None,
            "provider": None,
            "profileId": None,
            "roomCount": 0,
            "openingCount": 0,
            "furnitureCount": 0,
            "missingWallIds": [],
            "scaleConsistent": True,
            "validationErrors": [],
        }

    plan = layout.get("plan", {})
    width_mm = float(plan.get("widthMm", 0))
    depth_mm = float(plan.get("depthMm", 0))
    scale_consistent = (
        width_mm > 0
        and depth_mm > 0
        and abs(width_mm - float(payload["plan_width_mm"])) / width_mm <= 0.02
        and abs(depth_mm - float(payload["plan_depth_mm"])) / depth_mm <= 0.02
    )
    rooms = layout.get("rooms", [])
    walls = layout.get("walls", [])
    openings = layout.get("openings", [])
    furniture = layout.get("furniture", [])
    entity_groups = (rooms, walls, openings, furniture)
    all_ids = [str(item.get("id", "")) for group in entity_groups for item in group]
    ids_unique = bool(all_ids) and all(all_ids) and len(all_ids) == len(set(all_ids))
    room_ids = {str(room.get("id")) for room in rooms}

    def point_inside(point: dict[str, Any]) -> bool:
        x = float(point.get("xMm", -1))
        y = float(point.get("yMm", -1))
        return 0 <= x <= width_mm and 0 <= y <= depth_mm

    geometry_inside = all(
        point_inside(point)
        for wall in walls
        for point in (wall.get("start", {}), wall.get("end", {}))
    ) and all(
        point_inside(point)
        for opening in openings
        for point in (
            opening.get("segment", {}).get("start", {}),
            opening.get("segment", {}).get("end", {}),
        )
    )

    plan_shape = box(0, 0, width_mm, depth_mm) if width_mm > 0 and depth_mm > 0 else None
    room_shapes: dict[str, Polygon] = {}
    room_geometry_valid = bool(rooms) and plan_shape is not None
    for room in rooms:
        points = room.get("polygon", [])
        try:
            shape = Polygon([(float(point["xMm"]), float(point["yMm"])) for point in points])
        except (KeyError, TypeError, ValueError):
            room_geometry_valid = False
            continue
        if not shape.is_valid or shape.area < 100_000 or not plan_shape.buffer(5).covers(shape):
            room_geometry_valid = False
            continue
        room_shapes[str(room.get("id"))] = shape

    opening_refs_valid = all(
        bool(opening.get("roomIds"))
        and all(str(room_id) in room_ids for room_id in opening.get("roomIds", []))
        for opening in openings
    )

    wall_lines: list[LineString] = []
    wall_obstacles: list[Polygon] = []
    opening_lines: list[LineString] = []
    try:
        for wall in walls:
            line = LineString(
                [
                    (float(wall["start"]["xMm"]), float(wall["start"]["yMm"])),
                    (float(wall["end"]["xMm"]), float(wall["end"]["yMm"])),
                ]
            )
            wall_lines.append(line)
            thickness_mm = min(600.0, max(60.0, float(wall.get("thicknessMm", 100))))
            wall_obstacles.append(line.buffer(thickness_mm / 2, cap_style="flat"))
        opening_lines = [
            LineString(
                [
                    (
                        float(opening["segment"]["start"]["xMm"]),
                        float(opening["segment"]["start"]["yMm"]),
                    ),
                    (
                        float(opening["segment"]["end"]["xMm"]),
                        float(opening["segment"]["end"]["yMm"]),
                    ),
                ]
            )
            for opening in openings
        ]
    except (KeyError, TypeError, ValueError, GEOSException):
        wall_lines = []
        wall_obstacles = []
        opening_lines = []

    def axis_segment(line: LineString) -> tuple[str, float, float, float] | None:
        start = line.coords[0]
        end = line.coords[-1]
        if abs(start[1] - end[1]) <= 5:
            return "horizontal", (start[1] + end[1]) / 2, *sorted((start[0], end[0]))
        if abs(start[0] - end[0]) <= 5:
            return "vertical", (start[0] + end[0]) / 2, *sorted((start[1], end[1]))
        return None

    wall_axis_segments = [value for line in wall_lines if (value := axis_segment(line))]
    wall_segments_valid = len(wall_lines) == len(walls) and all(
        line.length >= 1 and axis_segment(line) is not None for line in wall_lines
    )
    opening_segments_valid = len(opening_lines) == len(openings) and all(
        line.length >= 1 and axis_segment(line) is not None for line in opening_lines
    )

    def endpoint_interval_distance(value: float, start: float, end: float) -> float:
        if start <= value <= end:
            return 0.0
        return min(abs(value - start), abs(value - end))

    def opening_has_collinear_support(line: LineString) -> bool:
        opening_axis = axis_segment(line)
        if opening_axis is None:
            return False
        axis, coordinate, opening_start, opening_end = opening_axis
        compatible = [
            item
            for item in wall_axis_segments
            if item[0] == axis and abs(item[1] - coordinate) <= 75
        ]
        if not compatible:
            return False
        start_supported = any(
            endpoint_interval_distance(opening_start, wall_start, wall_end) <= 75
            for _, _, wall_start, wall_end in compatible
        )
        end_supported = any(
            endpoint_interval_distance(opening_end, wall_start, wall_end) <= 75
            for _, _, wall_start, wall_end in compatible
        )
        interior_start = opening_start + min(75.0, (opening_end - opening_start) * 0.2)
        interior_end = opening_end - min(75.0, (opening_end - opening_start) * 0.2)
        wall_crosses_opening = interior_end > interior_start and any(
            min(wall_end, interior_end) - max(wall_start, interior_start) > 5
            for _, _, wall_start, wall_end in compatible
        )
        return start_supported and end_supported and not wall_crosses_opening

    opening_on_wall = bool(wall_lines) if opening_lines else True
    if opening_on_wall and opening_lines:
        opening_on_wall = all(opening_has_collinear_support(line) for line in opening_lines)

    def topology_lines_with_tolerance(
        lines: list[LineString],
        *,
        tolerance_mm: float = 75.0,
    ) -> list[LineString]:
        """Snap near-equal axis coordinates before polygonizing wall/opening chains."""

        segments = [value for line in lines if (value := axis_segment(line))]
        x_values: list[float] = []
        y_values: list[float] = []
        for axis, coordinate, start, end in segments:
            if axis == "horizontal":
                x_values.extend((start, end))
                y_values.append(coordinate)
            else:
                x_values.append(coordinate)
                y_values.extend((start, end))

        def clusters(values: list[float]) -> list[tuple[float, list[float]]]:
            grouped: list[list[float]] = []
            for value in sorted(values):
                if not grouped or abs(value - float(np.mean(grouped[-1]))) > tolerance_mm:
                    grouped.append([value])
                else:
                    grouped[-1].append(value)
            return [(float(np.mean(group)), group) for group in grouped]

        x_clusters = clusters(x_values)
        y_clusters = clusters(y_values)

        def snapped(value: float, grouped: list[tuple[float, list[float]]]) -> float:
            center, _members = min(grouped, key=lambda item: abs(item[0] - value))
            return center if abs(center - value) <= tolerance_mm else value

        normalized: list[LineString] = []
        for axis, coordinate, start, end in segments:
            if axis == "horizontal":
                first = (snapped(start, x_clusters), snapped(coordinate, y_clusters))
                second = (snapped(end, x_clusters), snapped(coordinate, y_clusters))
            else:
                first = (snapped(coordinate, x_clusters), snapped(start, y_clusters))
                second = (snapped(coordinate, x_clusters), snapped(end, y_clusters))
            line = LineString([first, second])
            if line.length >= 1:
                normalized.append(line)
        return normalized

    topology_closed = False
    if wall_lines:
        topology_lines = topology_lines_with_tolerance([*wall_lines, *opening_lines])
        closed_polygons = list(polygonize(unary_union(topology_lines)))
        closed_area = sum(polygon.area for polygon in closed_polygons)
        expected_room_area = sum(shape.area for shape in room_shapes.values())
        topology_closed = bool(closed_polygons) and (
            expected_room_area <= 0 or closed_area >= expected_room_area * 0.85
        )
    furniture_linked = True
    furniture_wall_clear = True
    door_clearance_valid = True
    furniture_collision_free = True
    furniture_footprints: list[tuple[str, str, Polygon]] = []
    wall_collision_ids: list[str] = []
    door_clearance_collision_ids: list[str] = []
    furniture_collisions: list[list[str]] = []
    wall_obstacle = unary_union(wall_obstacles) if wall_obstacles else None
    wall_centerline = unary_union(wall_lines) if wall_lines else None
    door_clearances = [
        line.buffer(300, cap_style="flat")
        for opening, line in zip(openings, opening_lines, strict=False)
        if str(opening.get("type", "")).lower() == "door"
    ]
    door_clearance = unary_union(door_clearances) if door_clearances else None
    for item in furniture:
        item_id = str(item.get("id", ""))
        item_type = str(item.get("type", "other")).lower()
        room_id = str(item.get("roomId", ""))
        room_shape = room_shapes.get(room_id)
        center = item.get("center", {})
        size = item.get("size", {})
        try:
            center_x = float(center["xMm"])
            center_y = float(center["yMm"])
            item_width = max(1.0, float(size["widthMm"]))
            item_depth = max(1.0, float(size["depthMm"]))
            footprint = box(
                center_x - item_width / 2,
                center_y - item_depth / 2,
                center_x + item_width / 2,
                center_y + item_depth / 2,
            )
            footprint = affinity.rotate(
                footprint,
                float(item.get("rotationDeg", 0)),
                origin=(center_x, center_y),
            )
        except (KeyError, TypeError, ValueError):
            furniture_linked = False
            continue
        if room_shape is None or not room_shape.buffer(100).covers(footprint):
            furniture_linked = False
        furniture_footprints.append((item_id, item_type, footprint))

        if wall_obstacle is not None and not wall_obstacle.is_empty:
            overlap_area = footprint.intersection(wall_obstacle).area
            overlap_ratio = overlap_area / max(1.0, footprint.area)
            # Furniture such as wardrobes and cabinets is intentionally placed
            # flush against a wall.  The previous 8% wall-buffer threshold
            # treated that normal placement as a collision.  Require the
            # furniture interior to cross the wall centreline, or a genuinely
            # large wall-volume overlap, before reporting a collision.
            inset_distance = max(20.0, min(item_width, item_depth) * 0.025)
            inset_footprint = footprint.buffer(-inset_distance)
            crosses_centerline = (
                wall_centerline is not None
                and not wall_centerline.is_empty
                and not inset_footprint.is_empty
                and inset_footprint.intersects(wall_centerline)
            )
            substantial_overlap = overlap_area >= 80_000 and overlap_ratio > 0.2
            if crosses_centerline or substantial_overlap:
                furniture_wall_clear = False
                wall_collision_ids.append(item_id)
        if door_clearance is not None and not door_clearance.is_empty:
            overlap_area = footprint.intersection(door_clearance).area
            if overlap_area >= 50_000 and overlap_area / max(1.0, footprint.area) > 0.1:
                door_clearance_valid = False
                door_clearance_collision_ids.append(item_id)

    allowed_overlap_pairs = {
        frozenset(("sectional_sofa", "coffee_table")),
        frozenset(("dining_table", "dining_chair")),
        frozenset(("kitchen_cabinet", "sink_cabinet")),
        frozenset(("kitchen_cabinet", "cooktop_cabinet")),
    }
    for index, (first_id, first_type, first_shape) in enumerate(furniture_footprints):
        for second_id, second_type, second_shape in furniture_footprints[index + 1 :]:
            if frozenset((first_type, second_type)) in allowed_overlap_pairs:
                continue
            overlap_area = first_shape.intersection(second_shape).area
            smaller_area = max(1.0, min(first_shape.area, second_shape.area))
            if overlap_area >= 80_000 and overlap_area / smaller_area > 0.2:
                furniture_collision_free = False
                furniture_collisions.append([first_id, second_id])

    expected_wall_ids = {str(wall.get("id")) for wall in walls}
    submitted_wall_ids = {str(wall.get("id")) for wall in payload.get("walls", [])}
    missing_wall_ids = sorted(expected_wall_ids - submitted_wall_ids)
    wall_geometry_consistent = not missing_wall_ids
    if wall_geometry_consistent:
        bounds = payload.get("detected_bounds", {})
        try:
            projected = {
                str(item["id"]): item for item in _semantic_wall_candidates(layout, bounds)
            }
        except (KeyError, TypeError, ValueError, ProcessorError):
            projected = {}
            wall_geometry_consistent = False
        submitted = {str(item.get("id")): item for item in payload.get("walls", [])}
        for wall_id, expected in projected.items():
            actual = submitted.get(wall_id)
            if actual is None:
                wall_geometry_consistent = False
                break
            direct = math.hypot(
                float(actual["x1"]) - float(expected["x1"]),
                float(actual["y1"]) - float(expected["y1"]),
            ) + math.hypot(
                float(actual["x2"]) - float(expected["x2"]),
                float(actual["y2"]) - float(expected["y2"]),
            )
            reversed_distance = math.hypot(
                float(actual["x1"]) - float(expected["x2"]),
                float(actual["y1"]) - float(expected["y2"]),
            ) + math.hypot(
                float(actual["x2"]) - float(expected["x1"]),
                float(actual["y2"]) - float(expected["y1"]),
            )
            if min(direct, reversed_distance) > 12:
                wall_geometry_consistent = False
                break

    blocking_checks = {
        "scale_inconsistent": scale_consistent,
        "duplicate_or_missing_ids": ids_unique,
        "insufficient_rooms": len(rooms) >= 1,
        "insufficient_walls": len(walls) >= 4,
        "invalid_wall_segments": wall_segments_valid,
        "invalid_opening_segments": opening_segments_valid,
        "geometry_outside_plan": geometry_inside,
        "invalid_room_geometry": room_geometry_valid,
        "invalid_opening_room_reference": opening_refs_valid,
        "missing_submitted_walls": not missing_wall_ids,
        "edited_wall_geometry_mismatch": wall_geometry_consistent,
    }
    warning_checks = {
        # Room polygons remain the authoritative floor surfaces for semantic
        # scenes.  Complex plans often contain balcony rails, partial-height
        # partitions, or openings that do not form one polygonizable wall
        # chain.  Keep the diagnostic visible, while allowing Blender to use
        # the already validated room polygons and individual wall segments.
        "wall_topology_not_closed": topology_closed,
        # Vision-model openings can be tens of millimetres away from the wall
        # centreline.  Blender snaps those openings to the nearest compatible
        # wall, so this is reviewable instead of fatal.
        "opening_not_on_wall": opening_on_wall,
        # Furniture placement diagnostics remain visible to the user, but do
        # not prevent a confirmed semantic layout from producing a render.
        # Large built-ins and sanitary fixtures frequently straddle the
        # vision model's room polygon by a small amount.
        "invalid_furniture_placement": furniture_linked,
        "furniture_wall_collision": furniture_wall_clear,
        "furniture_overlap": furniture_collision_free,
        "door_clearance_blocked": door_clearance_valid,
    }
    validation_errors = [
        code for code, valid in blocking_checks.items() if not valid
    ]
    validation_warnings = [
        code for code, valid in warning_checks.items() if not valid
    ]
    passed = not validation_errors
    return {
        "enabled": True,
        "passed": passed,
        "version": layout.get("version"),
        "provider": (layout.get("source") or {}).get("provider"),
        "profileId": layout.get("profileId"),
        "roomCount": len(rooms),
        "openingCount": len(openings),
        "furnitureCount": len(furniture),
        "missingWallIds": missing_wall_ids,
        "scaleConsistent": scale_consistent,
        "idsUnique": ids_unique,
        "geometryInside": geometry_inside,
        "wallSegmentsValid": wall_segments_valid,
        "openingSegmentsValid": opening_segments_valid,
        "roomGeometryValid": room_geometry_valid,
        "openingReferencesValid": opening_refs_valid,
        "openingsOnWalls": opening_on_wall,
        "topologyClosed": topology_closed,
        "furniturePlacementValid": furniture_linked,
        "furnitureWallClear": furniture_wall_clear,
        "furnitureCollisionFree": furniture_collision_free,
        "doorClearanceValid": door_clearance_valid,
        "wallCollisionIds": wall_collision_ids,
        "doorClearanceCollisionIds": door_clearance_collision_ids,
        "furnitureCollisions": furniture_collisions,
        "wallGeometryConsistent": wall_geometry_consistent,
        "validationErrors": validation_errors,
        "validationWarnings": validation_warnings,
    }


def _invalid_semantic_status(payload: dict[str, Any]) -> dict[str, Any]:
    layout = payload.get("semantic_layout")
    return {
        "enabled": isinstance(layout, dict),
        "passed": False,
        "version": layout.get("version") if isinstance(layout, dict) else None,
        "provider": None,
        "profileId": layout.get("profileId") if isinstance(layout, dict) else None,
        "roomCount": 0,
        "openingCount": 0,
        "furnitureCount": 0,
        "missingWallIds": [],
        "scaleConsistent": False,
        "idsUnique": False,
        "geometryInside": False,
        "wallSegmentsValid": False,
        "openingSegmentsValid": False,
        "roomGeometryValid": False,
        "openingReferencesValid": False,
        "openingsOnWalls": False,
        "topologyClosed": False,
        "furniturePlacementValid": False,
        "furnitureWallClear": False,
        "furnitureCollisionFree": False,
        "doorClearanceValid": False,
        "wallCollisionIds": [],
        "doorClearanceCollisionIds": [],
        "furnitureCollisions": [],
        "wallGeometryConsistent": False,
        "validationErrors": ["invalid_semantic_layout"],
        "validationWarnings": [],
    }


def _semantic_structure_status(payload: dict[str, Any]) -> dict[str, Any]:
    layout = payload.get("semantic_layout")
    if layout is None:
        return _semantic_structure_status_unchecked(payload)
    if not isinstance(layout, dict):
        return _invalid_semantic_status(payload)
    try:
        return _semantic_structure_status_unchecked(payload)
    except (
        AttributeError,
        GEOSException,
        KeyError,
        OverflowError,
        TypeError,
        ValueError,
        ZeroDivisionError,
    ):
        return _invalid_semantic_status(payload)


def _validate_scene(payload: dict[str, Any]) -> dict[str, Any]:
    if str(payload.get("schema_version", "")) == "0.5":
        if not bool(payload.get("semantic_review_confirmed")):
            raise ProcessorError(
                "INPUT_REJECTED",
                "V0.5 语义户型必须由用户确认结构后才能创建场景",
            )
        if not isinstance(payload.get("semantic_layout"), dict):
            raise ProcessorError(
                "INPUT_REJECTED",
                "V0.5 场景缺少可校验的 semanticLayout",
            )
    bounds = payload["detected_bounds"]
    room = payload["room_selection"]
    right = bounds["x"] + bounds["width"]
    bottom = bounds["y"] + bounds["height"]
    if (
        room["x"] < bounds["x"]
        or room["y"] < bounds["y"]
        or room["x"] + room["width"] > right
        or room["y"] + room["height"] > bottom
    ):
        raise ProcessorError("INPUT_REJECTED", "目标房间超出户型主体范围")
    room_width_mm = room["width"] / bounds["width"] * payload["plan_width_mm"]
    room_depth_mm = room["height"] / bounds["height"] * payload["plan_depth_mm"]
    if min(room_width_mm, room_depth_mm) < 2400:
        raise ProcessorError("INPUT_REJECTED", "目标房间至少需要 2400 × 2400 mm")
    semantic_status = _semantic_structure_status(payload)
    if not semantic_status["passed"]:
        missing = semantic_status["missingWallIds"]
        detail = f"，缺少墙线：{', '.join(missing)}" if missing else ""
        errors = semantic_status.get("validationErrors", [])
        if errors:
            detail += f"，问题：{', '.join(errors)}"
        raise ProcessorError(
            "INPUT_REJECTED",
            f"语义户型未通过结构质量门{detail}",
        )
    return semantic_status


def _scene_digest(payload: dict[str, Any]) -> str:
    structure = {
        key: payload.get(key)
        for key in (
            "schema_version",
            "plan_width_mm",
            "plan_depth_mm",
            "ceiling_height_mm",
            "wall_thickness_mm",
            "detected_bounds",
            "walls",
            "room_selection",
            "camera_preset_id",
            "layout_preset_id",
            "generation_mode",
            "render_quality",
            "style_preset_id",
            "enhancement_strength",
            "design_prompt",
            "semantic_layout",
            "semantic_review_confirmed",
        )
    }
    canonical = json.dumps(
        structure,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _fallback_topdown(payload: dict[str, Any]) -> np.ndarray:
    canvas = np.full((768, 1024, 3), (246, 247, 248), np.uint8)
    bounds = payload["detected_bounds"]
    scale = min(900 / bounds["width"], 650 / bounds["height"])
    offset_x = (1024 - bounds["width"] * scale) / 2
    offset_y = (768 - bounds["height"] * scale) / 2
    cv2.rectangle(
        canvas,
        (round(offset_x), round(offset_y)),
        (
            round(offset_x + bounds["width"] * scale),
            round(offset_y + bounds["height"] * scale),
        ),
        (205, 211, 214),
        -1,
    )
    for wall in payload["walls"]:
        p1 = (
            round(offset_x + (wall["x1"] - bounds["x"]) * scale),
            round(offset_y + (wall["y1"] - bounds["y"]) * scale),
        )
        p2 = (
            round(offset_x + (wall["x2"] - bounds["x"]) * scale),
            round(offset_y + (wall["y2"] - bounds["y"]) * scale),
        )
        cv2.line(canvas, p1, p2, (67, 82, 94), 8, cv2.LINE_AA)
    room = payload["room_selection"]
    cv2.rectangle(
        canvas,
        (
            round(offset_x + (room["x"] - bounds["x"]) * scale),
            round(offset_y + (room["y"] - bounds["y"]) * scale),
        ),
        (
            round(offset_x + (room["x"] + room["width"] - bounds["x"]) * scale),
            round(offset_y + (room["y"] + room["height"] - bounds["y"]) * scale),
        ),
        (46, 147, 120),
        3,
    )
    return canvas


def _fallback_interior(payload: dict[str, Any]) -> np.ndarray:
    image = np.full((768, 1024, 3), (238, 241, 243), np.uint8)
    horizon = 360
    cv2.rectangle(image, (0, 0), (1024, horizon), (224, 229, 232), -1)
    cv2.fillPoly(
        image,
        [np.array([[0, horizon], [1024, horizon], [1024, 768], [0, 768]])],
        (188, 177, 163),
    )
    cv2.line(image, (0, horizon), (1024, horizon), (92, 104, 112), 4)
    cv2.line(image, (0, 768), (440, horizon), (132, 121, 109), 3)
    cv2.line(image, (1024, 768), (584, horizon), (132, 121, 109), 3)
    cv2.putText(
        image,
        f"{payload.get('room_name', 'Room')} | {len(payload['walls'])} walls",
        (36, 52),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.75,
        (54, 74, 88),
        2,
        cv2.LINE_AA,
    )
    return image


def _direct_reference_images(
    payload: dict[str, Any],
    source_path: Path,
) -> tuple[Path, Path, np.ndarray]:
    output_width, output_height = 1536, 1024
    source = read_image(source_path)
    source_height, source_width = source.shape[:2]
    reference_scale = min(
        output_width / source_width,
        output_height / source_height,
    )
    resized_width = max(1, round(source_width * reference_scale))
    resized_height = max(1, round(source_height * reference_scale))
    resized_source = cv2.resize(
        source,
        (resized_width, resized_height),
        interpolation=(
            cv2.INTER_AREA if reference_scale < 1 else cv2.INTER_LANCZOS4
        ),
    )
    reference_offset_x = (output_width - resized_width) // 2
    reference_offset_y = (output_height - resized_height) // 2
    source_reference = np.full((output_height, output_width, 3), 255, np.uint8)
    source_reference[
        reference_offset_y : reference_offset_y + resized_height,
        reference_offset_x : reference_offset_x + resized_width,
    ] = resized_source
    source_reference_path = write_image(
        "floorplan-ai-direct-source",
        source_reference,
    )

    layout = payload.get("semantic_layout")
    if not isinstance(layout, dict):
        raise ProcessorError("INPUT_REJECTED", "AI 直出需要已确认的 semanticLayout")
    bounds = payload["detected_bounds"]
    plan_width = float(payload["plan_width_mm"])
    plan_depth = float(payload["plan_depth_mm"])

    def point(value: dict[str, Any]) -> tuple[int, int]:
        x_mm = float(value.get("xMm", 0))
        y_mm = float(value.get("yMm", 0))
        return (
            round(
                reference_offset_x
                + (float(bounds["x"]) + x_mm / plan_width * float(bounds["width"]))
                * reference_scale
            ),
            round(
                reference_offset_y
                + (float(bounds["y"]) + y_mm / plan_depth * float(bounds["height"]))
                * reference_scale
            ),
        )

    guide = np.full((output_height, output_width, 3), 255, np.uint8)
    palette = [
        (242, 235, 218),
        (232, 241, 221),
        (232, 226, 244),
        (221, 239, 242),
        (241, 226, 229),
        (226, 235, 246),
    ]
    for index, room in enumerate(layout.get("rooms", [])):
        if not isinstance(room, dict):
            continue
        polygon = room.get("polygon")
        if not isinstance(polygon, list) or len(polygon) < 3:
            rect = room.get("rect") or {}
            polygon = [
                {"xMm": rect.get("xMm", 0), "yMm": rect.get("yMm", 0)},
                {
                    "xMm": float(rect.get("xMm", 0)) + float(rect.get("widthMm", 0)),
                    "yMm": rect.get("yMm", 0),
                },
                {
                    "xMm": float(rect.get("xMm", 0)) + float(rect.get("widthMm", 0)),
                    "yMm": float(rect.get("yMm", 0)) + float(rect.get("depthMm", 0)),
                },
                {
                    "xMm": rect.get("xMm", 0),
                    "yMm": float(rect.get("yMm", 0)) + float(rect.get("depthMm", 0)),
                },
            ]
        points = np.asarray([point(item) for item in polygon], dtype=np.int32)
        cv2.fillPoly(guide, [points], palette[index % len(palette)])
        center = tuple(np.mean(points, axis=0).astype(int))
        cv2.putText(
            guide,
            str(room.get("type") or room.get("id") or "room")[:22],
            (center[0] - 42, center[1]),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.42,
            (92, 104, 112),
            1,
            cv2.LINE_AA,
        )

    wall_color = (235, 122, 46)
    for wall in layout.get("walls", []):
        if not isinstance(wall, dict):
            continue
        start = point(wall.get("start") or {})
        end = point(wall.get("end") or {})
        thickness = max(
            5,
            round(
                float(wall.get("thicknessMm", payload.get("wall_thickness_mm", 100)))
                / min(plan_width, plan_depth)
                * min(output_width, output_height)
            ),
        )
        cv2.line(guide, start, end, wall_color, thickness, cv2.LINE_AA)

    for opening in layout.get("openings", []):
        if not isinstance(opening, dict):
            continue
        start = point((opening.get("segment") or {}).get("start") or {})
        end = point((opening.get("segment") or {}).get("end") or {})
        color = (52, 162, 235) if opening.get("type") == "door" else (202, 174, 58)
        cv2.line(guide, start, end, color, 9, cv2.LINE_AA)

    for item in layout.get("furniture", []):
        if not isinstance(item, dict):
            continue
        center = point(item.get("center") or {})
        size = item.get("size") or {}
        width_px = max(
            4,
            float(size.get("widthMm", 100))
            / plan_width
            * float(bounds["width"])
            * reference_scale,
        )
        depth_px = max(
            4,
            float(size.get("depthMm", 100))
            / plan_depth
            * float(bounds["height"])
            * reference_scale,
        )
        box_points = cv2.boxPoints(
            (center, (width_px, depth_px), float(item.get("rotationDeg", 0)))
        ).astype(np.int32)
        cv2.fillPoly(guide, [box_points], (143, 199, 151))
        cv2.polylines(guide, [box_points], True, (70, 132, 82), 2, cv2.LINE_AA)

    semantic_path = write_image("floorplan-ai-direct-semantic", guide)
    return Path(source_reference_path), Path(semantic_path), source_reference


def run_floorplan_scene(payload: dict[str, Any]) -> dict[str, Any]:
    started_at = perf_counter()
    semantic_status = _validate_scene(payload)
    source_path = _resolve_source(payload["source_image_url"])
    generation_mode = str(payload.get("generation_mode", "structured_3d"))
    render_quality = payload.get("render_quality", "base")
    if generation_mode == "ai_direct":
        if render_quality != "final" or not bool(payload.get("enable_enhancement", True)):
            raise ProcessorError(
                "INPUT_REJECTED",
                "AI 直出模式固定使用最终增强质量；如需预览或基础渲染请切换精确三维模式",
            )
        source_reference_path, semantic_path, source_reference = _direct_reference_images(
            payload,
            source_path,
        )
        control_paths = {
            "edge": Path(write_image("floorplan-ai-direct-edge", edge_control(source_reference))),
            "semantic": semantic_path,
        }
        enhancement = generate_direct_floorplan_render(
            source_reference_path,
            semantic_path,
            payload,
        )
        provider = enhancement["provider"]
        topdown_path = semantic_path
        topdown_url = artifact_url(topdown_path)
        interior_url = enhancement["url"]
        dollhouse_path = Path(enhancement["path"])
        dollhouse = read_image(dollhouse_path)
        dollhouse_url = enhancement["url"]
        base_render_url = artifact_url(source_reference_path)
    else:
        use_blender = bool(payload.get("use_blender")) and render_quality != "preview"
        topdown_path = (
            render_floorplan_with_blender(payload, view_mode="topdown")
            if use_blender
            else None
        )
        interior_path = (
            render_floorplan_with_blender(payload, view_mode="interior")
            if use_blender
            else None
        )
        dollhouse_path = (
            render_floorplan_with_blender(payload, view_mode="dollhouse")
            if use_blender
            else None
        )
        if topdown_path:
            topdown_url = artifact_url(topdown_path)
        else:
            topdown = _fallback_topdown(payload)
            topdown_path = write_image("floorplan-topdown-fallback", topdown)
            topdown_url = artifact_url(topdown_path)

        if interior_path:
            interior_url = artifact_url(interior_path)
        else:
            interior = _fallback_interior(payload)
            interior_path = write_image("floorplan-interior-fallback", interior)
            interior_url = artifact_url(interior_path)

        if dollhouse_path:
            provider = "blender-floorplan-headless"
            dollhouse = read_image(dollhouse_path)
            dollhouse_url = artifact_url(dollhouse_path)
        else:
            provider = "local-floorplan-fallback"
            dollhouse = _fallback_topdown(payload)
            dollhouse_path = write_image("floorplan-dollhouse-fallback", dollhouse)
            dollhouse_url = artifact_url(dollhouse_path)

        control_paths = {}
        edge_path = write_image("floorplan-control-edge", edge_control(dollhouse))
        control_paths["edge"] = Path(edge_path)
        if use_blender and render_quality == "final":
            for control_name in ("depth", "normal", "semantic"):
                control_path = render_floorplan_with_blender(
                    payload,
                    view_mode=control_name,
                )
                if control_path:
                    control_paths[control_name] = control_path

        enhancement = enhance_floorplan_render(
            Path(dollhouse_path),
            control_paths,
            payload,
        )
        base_render_url = dollhouse_url
    bounds = payload["detected_bounds"]
    room = payload["room_selection"]
    room_width_mm = round(room["width"] / bounds["width"] * payload["plan_width_mm"])
    room_depth_mm = round(room["height"] / bounds["height"] * payload["plan_depth_mm"])
    consistency = enhancement["consistency"]
    width = int(dollhouse.shape[1])
    height = int(dollhouse.shape[0])
    digest = _scene_digest(payload)
    semantic_version = str(semantic_status.get("version") or "")
    schema_version = semantic_version if semantic_version in {"0.4", "0.5"} else "0.3"
    semantic_render_type = (
        "semantic-dollhouse-v5" if schema_version == "0.5" else "semantic-dollhouse-v4"
    )
    model_delivery = _model_delivery(
        generation_mode,
        provider,
        Path(dollhouse_path),
    )
    result = {
        "schemaVersion": schema_version,
        "sceneDigest": digest,
        "provider": provider,
        "renderProvider": provider,
        "generationMode": generation_mode,
        "renderType": (
            "semantic-ai-direct-v5"
            if generation_mode == "ai_direct"
            else semantic_render_type
            if semantic_status["enabled"]
            else "controlled-dollhouse-v3"
        ),
        "layoutMode": (
            "vision-semantic-layout"
            if schema_version == "0.5"
            else "reviewed-semantic-layout"
            if semantic_status["enabled"]
            else "geometric-fallback"
        ),
        "semanticProfileId": semantic_status["profileId"],
        "topDownUrl": topdown_url,
        "roomPreviewUrl": interior_url,
        "dollhouseUrl": dollhouse_url,
        "baseRenderUrl": base_render_url,
        "effectUrl": enhancement["url"],
        "finalRenderUrl": enhancement["url"],
        "modelDelivery": model_delivery,
        "controlImages": {f"{name}Url": artifact_url(path) for name, path in control_paths.items()},
        "enhancement": {
            "provider": enhancement["provider"],
            "modelRevision": enhancement["modelRevision"],
            "notice": enhancement["notice"],
            "requested": enhancement["requested"],
            "seed": enhancement["seed"],
            "seedMode": enhancement["seedMode"],
            "mode": enhancement["mode"],
            "controlImage": enhancement["controlImage"],
            "controlModel": enhancement["controlModel"],
            "rejectedProvider": enhancement["rejectedProvider"],
        },
        "renderInfo": {
            "quality": render_quality,
            "width": width,
            "height": height,
            "samples": (
                160
                if provider == "blender-floorplan-headless" and render_quality == "final"
                else 96
                if provider == "blender-floorplan-headless" and render_quality == "base"
                else 0
            ),
            "enhancementProvider": enhancement["provider"],
            "durationMs": round((perf_counter() - started_at) * 1000),
        },
        "room": {
            "name": payload.get("room_name", "客餐厅"),
            "widthMm": room_width_mm,
            "depthMm": room_depth_mm,
        },
        "structureCheck": {
            "passed": semantic_status["passed"] and consistency["passed"],
            "wallCount": len(payload["walls"]),
            "scaleConsistent": semantic_status["scaleConsistent"],
            "roomInsideBounds": True,
            "cameraInsideRoom": True,
            "furnitureIsSuggestion": not semantic_status["enabled"],
            "semanticLayoutValidated": semantic_status["enabled"],
            "semanticProfileId": semantic_status["profileId"],
            "semanticProvider": semantic_status["provider"],
            "roomCount": semantic_status["roomCount"],
            "openingCount": semantic_status["openingCount"],
            "furnitureCount": semantic_status["furnitureCount"],
            "missingWallIds": semantic_status["missingWallIds"],
            "wallGeometryConsistent": semantic_status.get("wallGeometryConsistent", True),
            "wallSegmentsValid": semantic_status.get("wallSegmentsValid", True),
            "openingSegmentsValid": semantic_status.get("openingSegmentsValid", True),
            "openingsOnWalls": semantic_status.get("openingsOnWalls", True),
            "topologyClosed": semantic_status.get("topologyClosed", True),
            "roomGeometryValid": semantic_status.get("roomGeometryValid", True),
            "furniturePlacementValid": semantic_status.get(
                "furniturePlacementValid", True
            ),
            "furnitureWallClear": semantic_status.get("furnitureWallClear", True),
            "furnitureCollisionFree": semantic_status.get(
                "furnitureCollisionFree", True
            ),
            "doorClearanceValid": semantic_status.get("doorClearanceValid", True),
            "wallCollisionIds": semantic_status.get("wallCollisionIds", []),
            "doorClearanceCollisionIds": semantic_status.get(
                "doorClearanceCollisionIds", []
            ),
            "furnitureCollisions": semantic_status.get("furnitureCollisions", []),
            "validationErrors": semantic_status.get("validationErrors", []),
            "validationWarnings": semantic_status.get("validationWarnings", []),
            "outputSizeMatches": consistency["outputSizeMatches"],
            "edgeRetention": consistency["edgeRetention"],
            "layoutDriftScore": consistency["layoutDriftScore"],
            "wallsPreserved": consistency["passed"],
            **{
                key: consistency[key]
                for key in (
                    "inputSizeMatches",
                    "registrationApplied",
                    "registrationMode",
                    "semanticWallRetention",
                    "localWallRetention",
                    "localWallRetentionQ20",
                    "wallTileCount",
                    "wallTolerancePx",
                    "registrationScaleX",
                    "registrationScaleY",
                    "registrationAnisotropy",
                    "registrationRotationDeg",
                    "registrationPerspectiveRatio",
                    "auditRegistrationApplied",
                    "auditRegistrationMode",
                    "outputTransformApplied",
                )
                if key in consistency
            },
            "requiresUserConfirmation": True,
        },
    }
    manifest = {
        "schemaVersion": schema_version,
        "sceneDigest": digest,
        "generationMode": generation_mode,
        "renderProvider": provider,
        "renderType": result["renderType"],
        "baseRenderUrl": result["baseRenderUrl"],
        "finalRenderUrl": result["finalRenderUrl"],
        "modelDelivery": result["modelDelivery"],
        "controlImages": result["controlImages"],
        "enhancement": result["enhancement"],
        "renderInfo": result["renderInfo"],
        "structureCheck": result["structureCheck"],
    }
    manifest_path = artifact_path("floorplan-render-manifest", ".json")
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    result["manifestUrl"] = artifact_url(manifest_path)
    return result
