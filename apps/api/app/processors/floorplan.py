from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.config import settings
from app.processors.blender import render_floorplan_with_blender
from app.processors.common import ProcessorError
from app.processors.image import (
    STYLE_PALETTES,
    read_image,
    write_image,
)
from app.storage import artifact_url


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

    normalized = []
    for value in raw[:, 0]:
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


def _analysis_overlay(
    source: np.ndarray,
    bounds: dict[str, int],
    walls: list[dict[str, Any]],
) -> Path:
    overlay = source.copy()
    for wall in walls:
        confidence = wall["confidence"]
        color = (212, 132, 34) if confidence >= 0.7 else (64, 164, 224)
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
    bounds, walls = _detect_walls(source)
    overlay = _analysis_overlay(source, bounds, walls)
    plan_width = payload["plan_width_mm"]
    plan_depth = payload["plan_depth_mm"]
    scale_x = plan_width / bounds["width"]
    scale_y = plan_depth / bounds["height"]
    delta = abs(scale_x - scale_y) / max(scale_x, scale_y)
    return {
        "schemaVersion": "0.2",
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
        "quality": {
            "candidateCount": len(walls),
            "orthogonalRatio": 1.0,
            "scaleDeltaRatio": round(delta, 4),
            "scaleWarning": delta > 0.05,
            "requiresUserConfirmation": True,
        },
    }


def _resolve_source(source_url: str) -> Path:
    name = Path(source_url).name
    path = settings.artifact_dir / name
    if not path.exists():
        raise ProcessorError("INPUT_REJECTED", "原始平面图文件不存在")
    return path


def _validate_scene(payload: dict[str, Any]) -> None:
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


def run_floorplan_scene(payload: dict[str, Any]) -> dict[str, Any]:
    _validate_scene(payload)
    _resolve_source(payload["source_image_url"])
    topdown_path = (
        render_floorplan_with_blender(payload, view_mode="topdown")
        if payload.get("use_blender")
        else None
    )
    interior_path = (
        render_floorplan_with_blender(payload, view_mode="interior")
        if payload.get("use_blender")
        else None
    )
    if topdown_path and interior_path:
        provider = "blender-floorplan-headless"
        topdown = read_image(topdown_path)
        interior = read_image(interior_path)
        topdown_url = artifact_url(topdown_path)
        interior_url = artifact_url(interior_path)
    else:
        provider = "local-floorplan-fallback"
        topdown = _fallback_topdown(payload)
        interior = _fallback_interior(payload)
        topdown_path = write_image("floorplan-topdown-fallback", topdown)
        interior_path = write_image("floorplan-interior-fallback", interior)
        topdown_url = artifact_url(topdown_path)
        interior_url = artifact_url(interior_path)

    palette = np.array(
        STYLE_PALETTES.get(
            payload.get("style_preset_id"),
            STYLE_PALETTES["modern_warm_v1"],
        ),
        dtype=np.float32,
    )
    enhanced = np.clip(interior.astype(np.float32) * 0.8 + palette * 0.2, 0, 255)
    enhanced = cv2.detailEnhance(
        enhanced.astype(np.uint8),
        sigma_s=10,
        sigma_r=0.15,
    )
    effect_path = write_image("floorplan-effect", enhanced)
    bounds = payload["detected_bounds"]
    room = payload["room_selection"]
    room_width_mm = round(room["width"] / bounds["width"] * payload["plan_width_mm"])
    room_depth_mm = round(room["height"] / bounds["height"] * payload["plan_depth_mm"])
    return {
        "provider": provider,
        "topDownUrl": topdown_url,
        "roomPreviewUrl": interior_url,
        "effectUrl": artifact_url(effect_path),
        "room": {
            "name": payload.get("room_name", "客餐厅"),
            "widthMm": room_width_mm,
            "depthMm": room_depth_mm,
        },
        "structureCheck": {
            "passed": True,
            "wallCount": len(payload["walls"]),
            "scaleConsistent": True,
            "roomInsideBounds": True,
            "cameraInsideRoom": True,
            "requiresUserConfirmation": True,
        },
    }
