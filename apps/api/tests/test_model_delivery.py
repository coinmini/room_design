from __future__ import annotations

import ast
import json
from pathlib import Path

import cv2
import numpy as np
from pytest import MonkeyPatch

from app.config import settings
from app.processors.floorplan import _model_delivery, run_floorplan_scene


def test_ai_direct_never_exposes_model_urls(tmp_path: Path) -> None:
    render_path = tmp_path / "ai-direct.png"
    render_path.with_suffix(".blend").write_bytes(b"not-for-direct-mode")
    render_path.with_suffix(".glb").write_bytes(b"not-for-direct-mode")

    delivery = _model_delivery("ai_direct", "kuyao-gpt-image-2", render_path)

    assert delivery["editable"] is False
    assert delivery["blendUrl"] is None
    assert delivery["glbUrl"] is None
    assert delivery["cameraPresets"] == []
    assert delivery["materialPresets"] == []


def test_structured_delivery_only_links_files_that_exist(tmp_path: Path) -> None:
    render_path = tmp_path / "canonical-dollhouse.png"
    blend_path = render_path.with_suffix(".blend")
    blend_path.write_bytes(b"blend")

    without_glb = _model_delivery(
        "structured_3d",
        "blender-floorplan-headless",
        render_path,
    )
    assert without_glb["editable"] is True
    assert without_glb["blendUrl"] == "/artifacts/canonical-dollhouse.blend"
    assert without_glb["glbUrl"] is None
    assert [item["id"] for item in without_glb["cameraPresets"]] == [
        "dollhouse",
        "topdown",
        "corner_01",
        "corner_02",
        "eye_level_01",
    ]

    render_path.with_suffix(".glb").write_bytes(b"glb")
    with_glb = _model_delivery(
        "structured_3d",
        "blender-floorplan-headless",
        render_path,
    )
    assert with_glb["glbUrl"] == "/artifacts/canonical-dollhouse.glb"
    assert [item["id"] for item in with_glb["materialPresets"]] == [
        "modern_warm_v1",
        "modern_minimal_v1",
        "natural_wood_v1",
    ]

    fallback = _model_delivery(
        "structured_3d",
        "local-floorplan-fallback",
        render_path,
    )
    assert fallback["editable"] is False
    assert fallback["blendUrl"] is None
    assert fallback["glbUrl"] is None


def test_blender_delivery_script_defines_cameras_export_and_distinct_palettes() -> None:
    script_path = (
        Path(__file__).resolve().parents[1]
        / "app"
        / "processors"
        / "blender_floorplan_scene.py"
    )
    source = script_path.read_text(encoding="utf-8")
    tree = ast.parse(source)
    palette_node = next(
        node.value
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id == "style_palettes"
            for target in node.targets
        )
    )
    palettes = ast.literal_eval(palette_node)

    assert "bpy.ops.export_scene.gltf(" in source
    assert 'if view_mode == "dollhouse":' in source
    for camera_id in (
        "dollhouse",
        "topdown",
        "corner_01",
        "corner_02",
        "eye_level_01",
    ):
        assert f'"{camera_id}"' in source
    for material_group in ("wall", "floor", "wood", "fabric"):
        colors = {
            tuple(palettes[preset_id][material_group])
            for preset_id in (
                "modern_warm_v1",
                "modern_minimal_v1",
                "natural_wood_v1",
            )
        }
        assert len(colors) == 3


def test_structured_scene_result_and_manifest_expose_canonical_delivery(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    source_path = tmp_path / "source.png"
    source = np.full((420, 640, 3), 245, dtype=np.uint8)
    assert cv2.imwrite(str(source_path), source)

    render_image = np.full((768, 1024, 3), 236, dtype=np.uint8)
    cv2.rectangle(render_image, (80, 80), (944, 688), (40, 40, 40), 7)

    def fake_blender(_payload: dict, *, view_mode: str) -> Path:
        render_path = tmp_path / f"canonical-{view_mode}.png"
        assert cv2.imwrite(str(render_path), render_image)
        if view_mode == "dollhouse":
            render_path.with_suffix(".blend").write_bytes(b"blend")
            render_path.with_suffix(".glb").write_bytes(b"glb")
        return render_path

    monkeypatch.setattr(
        "app.processors.floorplan.render_floorplan_with_blender",
        fake_blender,
    )
    bounds = {"x": 45, "y": 45, "width": 550, "height": 330}
    payload = {
        "schema_version": "0.3",
        "source_image_url": "/artifacts/source.png",
        "image_width": 640,
        "image_height": 420,
        "plan_width_mm": 6000,
        "plan_depth_mm": 4000,
        "ceiling_height_mm": 2800,
        "wall_thickness_mm": 100,
        "detected_bounds": bounds,
        "walls": [
            {"id": "top", "x1": 45, "y1": 45, "x2": 595, "y2": 45},
            {"id": "right", "x1": 595, "y1": 45, "x2": 595, "y2": 375},
            {"id": "bottom", "x1": 595, "y1": 375, "x2": 45, "y2": 375},
            {"id": "left", "x1": 45, "y1": 375, "x2": 45, "y2": 45},
        ],
        "room_selection": bounds,
        "room_name": "交付测试",
        "style_preset_id": "natural_wood_v1",
        "camera_preset_id": "corner_01",
        "layout_preset_id": "auto",
        "generation_mode": "structured_3d",
        "render_quality": "base",
        "enable_enhancement": False,
        "enhancement_strength": 0.62,
        "enhancement_seed": 17,
        "design_prompt": "",
        "use_blender": True,
    }

    result = run_floorplan_scene(payload)

    delivery = result["modelDelivery"]
    assert delivery["editable"] is True
    assert delivery["blendUrl"] == "/artifacts/canonical-dollhouse.blend"
    assert delivery["glbUrl"] == "/artifacts/canonical-dollhouse.glb"
    assert delivery["canonicalView"] == "dollhouse"
    manifest_path = tmp_path / Path(result["manifestUrl"]).name
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["modelDelivery"] == delivery
