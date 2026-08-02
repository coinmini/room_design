from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any

from app.processors.floorplan_semantic import (
    GOLDEN_FLOORPLAN_SHA256,
    compile_semantic_layout,
)


WORKSPACE_ROOT = Path(__file__).resolve().parents[3]
GOLDEN_FLOORPLAN = WORKSPACE_ROOT / "example" / "平面图.jpeg"


def _axis_segment(item: dict[str, Any]) -> tuple[str, int, int, int]:
    start = item["start"]
    end = item["end"]
    if start["yMm"] == end["yMm"]:
        return "horizontal", start["yMm"], *sorted((start["xMm"], end["xMm"]))
    if start["xMm"] == end["xMm"]:
        return "vertical", start["xMm"], *sorted((start["yMm"], end["yMm"]))
    raise AssertionError(f"segment is not orthogonal: {item}")


def test_golden_floorplan_compiles_by_exact_sha256() -> None:
    raw = GOLDEN_FLOORPLAN.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == GOLDEN_FLOORPLAN_SHA256

    from_path = compile_semantic_layout(GOLDEN_FLOORPLAN)
    from_bytes = compile_semantic_layout(raw)

    assert from_path == from_bytes
    assert from_path is not None
    assert from_path["version"] == "0.4"
    assert from_path["profileId"] == "cn_two_bedroom_8150x6060_v1"
    assert from_path["sourceSha256"] == GOLDEN_FLOORPLAN_SHA256
    assert from_path["coordinateSystem"] == {
        "unit": "mm",
        "origin": "top_left",
        "xAxis": "right",
        "yAxis": "down",
    }
    assert from_path["plan"]["widthMm"] == 8150
    assert from_path["plan"]["depthMm"] == 6060


def test_unknown_image_does_not_receive_golden_semantics() -> None:
    assert compile_semantic_layout(b"not the registered floor plan") is None


def test_rooms_expose_rectangles_polygons_and_stable_types() -> None:
    layout = compile_semantic_layout(GOLDEN_FLOORPLAN)
    assert layout is not None

    rooms = layout["rooms"]
    assert {room["type"] for room in rooms} == {
        "bedroom",
        "bathroom",
        "living_dining",
        "kitchen",
    }
    assert len([room for room in rooms if room["type"] == "bedroom"]) == 2
    assert len({room["id"] for room in rooms}) == len(rooms)

    for room in rooms:
        assert room["name"]
        assert room["rect"]["widthMm"] > 0
        assert room["rect"]["depthMm"] > 0
        assert len(room["polygon"]) >= 4
        assert all(set(point) == {"xMm", "yMm"} for point in room["polygon"])


def test_wall_centerlines_are_split_around_every_opening() -> None:
    layout = compile_semantic_layout(GOLDEN_FLOORPLAN)
    assert layout is not None

    wall_segments = [_axis_segment(wall) for wall in layout["walls"]]
    for opening in layout["openings"]:
        segment = opening["segment"]
        axis, coordinate, opening_start, opening_end = _axis_segment(segment)
        assert axis == opening["wallAxis"]
        assert opening["widthMm"] == opening_end - opening_start
        assert opening["type"] in {"door", "window"}

        for wall_axis, wall_coordinate, wall_start, wall_end in wall_segments:
            if wall_axis != axis or wall_coordinate != coordinate:
                continue
            overlap = min(wall_end, opening_end) - max(wall_start, opening_start)
            assert overlap <= 0, f"wall crosses opening {opening['id']}"


def test_furniture_uses_mm_centers_sizes_and_known_room_ids() -> None:
    layout = compile_semantic_layout(GOLDEN_FLOORPLAN)
    assert layout is not None

    rooms = {room["id"]: room for room in layout["rooms"]}
    for item in layout["furniture"]:
        room = rooms[item["roomId"]]
        center = item["center"]
        rect = room["rect"]
        assert rect["xMm"] <= center["xMm"] <= rect["xMm"] + rect["widthMm"]
        assert rect["yMm"] <= center["yMm"] <= rect["yMm"] + rect["depthMm"]
        assert all(item["size"][key] > 0 for key in ("widthMm", "depthMm", "heightMm"))
        assert math.isfinite(item["rotationDeg"])


def test_compilation_returns_an_independent_layout_object() -> None:
    first = compile_semantic_layout(GOLDEN_FLOORPLAN)
    second = compile_semantic_layout(GOLDEN_FLOORPLAN)
    assert first is not None and second is not None

    first["rooms"][0]["name"] = "mutated"
    assert second["rooms"][0]["name"] != "mutated"
