from __future__ import annotations

import hashlib
import json
from pathlib import Path
import struct
import zlib

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from pytest import MonkeyPatch
from sqlalchemy import select

from app.config import settings
from app.database import SessionLocal
from app.jobs import PROCESSORS, create_job
from app.main import app
from app.models import Job
from app.processors.common import ProcessorError
from app.processors.floorplan import (
    _direct_reference_images,
    _semantic_structure_status,
    _validate_scene,
    run_floorplan_scene,
)
from app.processors.floorplan_enhancement import (
    EnhancementResult,
    enhance_floorplan_render,
    enhancement_capability,
    generate_direct_floorplan_render,
    structure_consistency,
)
from app.schemas import FloorplanSceneRequest


@pytest.fixture(autouse=True)
def disable_live_floorplan_vision(monkeypatch: MonkeyPatch) -> None:
    """The API suite must never spend credits or upload fixtures to a live provider."""
    monkeypatch.setattr(settings, "floorplan_vision_provider", "local")
    monkeypatch.setattr(settings, "kuyao_api_key", "")
    monkeypatch.setattr(settings, "openai_api_key", "")


def image_bytes() -> bytes:
    image = np.full((420, 640, 3), 255, dtype=np.uint8)
    cv2.rectangle(image, (45, 45), (595, 375), (128, 114, 107), 8)
    cv2.rectangle(image, (170, 180), (470, 300), (184, 163, 148), 5)
    success, output = cv2.imencode(".png", image)
    assert success
    return output.tobytes()


def oversized_png_header(width: int = 10_001, height: int = 100) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        checksum = zlib.crc32(kind + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")


def semantic_status_payload(
    *,
    furniture: list[dict] | None = None,
    openings: list[dict] | None = None,
    include_center_wall: bool = False,
) -> dict:
    walls = [
        {
            "id": "wall_top",
            "kind": "exterior",
            "start": {"xMm": 0, "yMm": 0},
            "end": {"xMm": 6000, "yMm": 0},
            "thicknessMm": 100,
        },
        {
            "id": "wall_right",
            "kind": "exterior",
            "start": {"xMm": 6000, "yMm": 0},
            "end": {"xMm": 6000, "yMm": 4000},
            "thicknessMm": 100,
        },
        {
            "id": "wall_bottom",
            "kind": "exterior",
            "start": {"xMm": 6000, "yMm": 4000},
            "end": {"xMm": 0, "yMm": 4000},
            "thicknessMm": 100,
        },
        {
            "id": "wall_left",
            "kind": "exterior",
            "start": {"xMm": 0, "yMm": 4000},
            "end": {"xMm": 0, "yMm": 0},
            "thicknessMm": 100,
        },
    ]
    if include_center_wall:
        walls.append(
            {
                "id": "wall_center",
                "kind": "interior",
                "start": {"xMm": 3000, "yMm": 0},
                "end": {"xMm": 3000, "yMm": 4000},
                "thicknessMm": 100,
            }
        )

    detected_bounds = {"x": 0, "y": 0, "width": 600, "height": 400}
    pixel_walls = [
        {
            "id": wall["id"],
            "x1": wall["start"]["xMm"] / 10,
            "y1": wall["start"]["yMm"] / 10,
            "x2": wall["end"]["xMm"] / 10,
            "y2": wall["end"]["yMm"] / 10,
            "source": "semantic",
        }
        for wall in walls
    ]
    return {
        "schema_version": "0.5",
        "semantic_review_confirmed": True,
        "plan_width_mm": 6000,
        "plan_depth_mm": 4000,
        "detected_bounds": detected_bounds,
        "walls": pixel_walls,
        "semantic_layout": {
            "version": "0.5",
            "profileId": "test_layout",
            "source": {"provider": "test"},
            "plan": {"widthMm": 6000, "depthMm": 4000},
            "rooms": [
                {
                    "id": "room_main",
                    "type": "living_room",
                    "polygon": [
                        {"xMm": 0, "yMm": 0},
                        {"xMm": 6000, "yMm": 0},
                        {"xMm": 6000, "yMm": 4000},
                        {"xMm": 0, "yMm": 4000},
                    ],
                }
            ],
            "walls": walls,
            "openings": openings or [],
            "furniture": furniture or [],
        },
    }


def completed_job(client: TestClient, response) -> dict:
    assert response.status_code == 202, response.text
    job_id = response.json()["id"]
    job = client.get(f"/v1/jobs/{job_id}")
    assert job.status_code == 200
    assert job.json()["status"] == "SUCCEEDED", job.json()
    return job.json()


def test_health_and_projects() -> None:
    with TestClient(app) as client:
        health = client.get("/health").json()
        assert health["status"] == "ok"
        assert health["version"] == "0.6.0"
        assert health["productionGeneration"] == "ai_workflow"
        assert health["blenderWorkflowEnabled"] is False
        assert "legacyBlenderAvailable" in health
        assert "floorplanAiConfigured" in health
        assert "floorplanEnhancement" in health
        assert health["floorplanVision"]["configured"] is False
        assert health["floorplanEnhancement"]["configured"] is False
        assert health["floorplanEnhancement"]["legacyOnly"] is True
        assert health["floorplanEnhancement"]["productionEnabled"] is False
        assert health["aiDesignWorkflow"]["blenderRequired"] is False
        response = client.post(
            "/v1/projects",
            json={"name": "本地 MVP 测试项目"},
        )
        assert response.status_code == 201
        assert response.json()["name"] == "本地 MVP 测试项目"


def test_four_module_jobs(monkeypatch: MonkeyPatch) -> None:
    source = image_bytes()
    stage01 = semantic_status_payload()
    stage01_semantic = stage01["semantic_layout"]
    stage01_semantic["sourceSha256"] = hashlib.sha256(source).hexdigest()
    stage01_semantic["validation"] = {
        "status": "human_confirmed",
        "humanConfirmed": True,
    }
    with SessionLocal() as session:
        stage01_job = create_job(
            session,
            job_type="FLOORPLAN_ANALYZE",
            payload={"source_path": "stage01-api-test.png"},
        )
        stage01_job.status = "SUCCEEDED"
        stage01_job.progress = 1.0
        stage01_job.result = {
            "semanticLayout": stage01_semantic,
            "detectedBounds": stage01["detected_bounds"],
        }
        session.commit()
        stage01_job_id = stage01_job.id
    monkeypatch.setitem(
        PROCESSORS,
        "LAYOUT_AI",
        lambda _payload: {
            "generationMode": "ai_image",
            "layouts": [
                {
                    "layoutId": "layout_ai_test",
                    "previewUrl": "/artifacts/layout-ai-test.png",
                    "generationMode": "ai_image",
                }
            ],
            "count": 1,
        },
    )
    with TestClient(app) as client:
        layout = completed_job(
            client,
            client.post(
                "/v1/layouts/ai",
                files={"source_image": ("stage01.png", source, "image/png")},
                data={
                    "room_type": "living_room",
                    "count": "1",
                    "semantic_layout": json.dumps(stage01_semantic),
                    "stage01_analysis_job_id": stage01_job_id,
                    "stage01_approved_version_id": f"{stage01_job_id}:approved",
                    "stage01_source_sha256": stage01_semantic["sourceSha256"],
                    "stage01_detected_bounds": json.dumps(stage01["detected_bounds"]),
                },
            ),
        )
        assert len(layout["result"]["layouts"]) == 1

        white = completed_job(
            client,
            client.post(
                "/v1/white-model-renders",
                files={"source_image": ("white.png", source, "image/png")},
                data={
                    "style_preset_id": "modern_minimal_v1",
                    "generation_mode": "local_preview",
                },
            ),
        )
        assert len(white["result"]["outputs"]) == 2

        effect = completed_job(
            client,
            client.post(
                "/v1/effect-renders",
                json={
                    "roomType": "living_room",
                    "widthMm": 5200,
                    "depthMm": 4200,
                    "useBlender": False,
                },
            ),
        )
        assert effect["result"]["structureCheck"]["passed"] is True

        material = completed_job(
            client,
            client.post(
                "/v1/material-replacement-renders",
                files={"source_image": ("room.png", source, "image/png")},
                data={"wall_style": "warm_gray", "floor_style": "oak_light"},
            ),
        )
        assert material["result"]["outsideMaskPolicy"] == "source_pixels_preserved"


def test_retired_layout_solver_returns_410_without_creating_job() -> None:
    with TestClient(app) as client:
        session = SessionLocal()
        try:
            before_ids = set(session.scalars(select(Job.id)))
        finally:
            session.close()

        response = client.post(
            "/v1/layouts",
            json={
                "roomType": "living_room",
                "widthMm": 5200,
                "depthMm": 4200,
                "count": 2,
            },
        )

        assert response.status_code == 410
        assert "/v1/layouts/ai" in response.json()["detail"]
        assert "/v1/layouts" not in client.get("/openapi.json").json()["paths"]

        session = SessionLocal()
        try:
            assert set(session.scalars(select(Job.id))) == before_ids
        finally:
            session.close()


def test_historical_layout_job_cannot_be_retried() -> None:
    session = SessionLocal()
    try:
        historical = create_job(
            session,
            job_type="LAYOUT",
            payload={
                "room_type": "living_room",
                "width_mm": 5200,
                "depth_mm": 4200,
            },
        )
        historical_job_id = historical.id
        before_ids = set(session.scalars(select(Job.id)))
    finally:
        session.close()

    with TestClient(app) as client:
        response = client.post(f"/v1/jobs/{historical_job_id}/retry")

    assert response.status_code == 410
    assert "/v1/layouts/ai" in response.json()["detail"]
    session = SessionLocal()
    try:
        assert set(session.scalars(select(Job.id))) == before_ids
    finally:
        session.close()


def test_v04_floorplan_to_scene_flow_with_local_fallback() -> None:
    source = image_bytes()
    with TestClient(app) as client:
        analysis_job = completed_job(
            client,
            client.post(
                "/v1/floorplans/analyze",
                files={"source_image": ("floorplan.png", source, "image/png")},
                data={"plan_width_mm": "6000", "plan_depth_mm": "4000"},
            ),
        )
        analysis = analysis_job["result"]
        assert analysis["schemaVersion"] == "0.5"
        assert analysis["semanticLayout"] is None
        assert analysis["quality"]["recognitionMode"] == "geometric-fallback"
        assert analysis["quality"]["candidateCount"] >= 4
        assert analysis["quality"]["requiresUserConfirmation"] is True

        bounds = analysis["detectedBounds"]
        walls = [
            {
                "id": wall["id"],
                "x1": wall["x1"],
                "y1": wall["y1"],
                "x2": wall["x2"],
                "y2": wall["y2"],
                "source": wall["source"],
            }
            for wall in analysis["wallCandidates"][:16]
        ]
        scene_job = completed_job(
            client,
            client.post(
                "/v1/floorplan-scenes",
                json={
                    "schemaVersion": "0.3",
                    "sourceImageUrl": analysis["sourceImageUrl"],
                    "imageWidth": analysis["imageWidth"],
                    "imageHeight": analysis["imageHeight"],
                    "planWidthMm": 6000,
                    "planDepthMm": 4000,
                    "detectedBounds": bounds,
                    "walls": walls,
                    "roomSelection": {
                        "x": bounds["x"],
                        "y": bounds["y"],
                        "width": bounds["width"],
                        "height": bounds["height"],
                    },
                    "roomName": "测试客厅",
                    "renderQuality": "final",
                    "enableEnhancement": True,
                    "useBlender": False,
                },
            ),
        )
        scene = scene_job["result"]
        assert scene["provider"] == "local-floorplan-fallback"
        assert scene["renderType"] == "controlled-dollhouse-v3"
        assert scene["dollhouseUrl"].endswith(".png")
        assert scene["baseRenderUrl"].endswith(".png")
        assert scene["finalRenderUrl"].endswith(".png")
        assert scene["controlImages"]["edgeUrl"].endswith(".png")
        assert scene["enhancement"]["provider"] == "local-structure-preserving-v2"
        assert scene["enhancement"]["seed"] == 17
        assert scene["enhancement"]["mode"] == "registered-local-fallback"
        assert scene["room"]["name"] == "测试客厅"
        assert scene["structureCheck"]["wallCount"] == len(walls)
        assert scene["structureCheck"]["furnitureIsSuggestion"] is True
        assert scene["structureCheck"]["wallsPreserved"] is True
        assert scene["structureCheck"]["edgeRetention"] >= 0.72
        assert scene["structureCheck"]["requiresUserConfirmation"] is True


def test_v04_registered_floorplan_returns_reviewed_semantics() -> None:
    workspace_root = Path(__file__).resolve().parents[3]
    source = (workspace_root / "example" / "平面图.jpeg").read_bytes()
    with TestClient(app) as client:
        analysis_job = completed_job(
            client,
            client.post(
                "/v1/floorplans/analyze",
                files={"source_image": ("平面图.jpeg", source, "image/jpeg")},
                data={"plan_width_mm": "8150", "plan_depth_mm": "6060"},
            ),
        )

    analysis = analysis_job["result"]
    semantic = analysis["semanticLayout"]
    assert analysis["schemaVersion"] == "0.5"
    assert analysis["quality"]["recognitionMode"] == "reviewed-semantic-fixture"
    assert semantic["profileId"] == "cn_two_bedroom_8150x6060_v1"
    assert len(semantic["rooms"]) == 5
    assert len(semantic["openings"]) == 9
    assert all(wall["source"] == "semantic" for wall in analysis["wallCandidates"])

    bounds = analysis["detectedBounds"]
    living = next(room for room in semantic["rooms"] if room["type"] == "living_dining")
    rect = living["rect"]
    plan = semantic["plan"]
    room_selection = {
        "x": bounds["x"] + rect["xMm"] / plan["widthMm"] * bounds["width"],
        "y": bounds["y"] + rect["yMm"] / plan["depthMm"] * bounds["height"],
        "width": rect["widthMm"] / plan["widthMm"] * bounds["width"],
        "height": rect["depthMm"] / plan["depthMm"] * bounds["height"],
    }
    with TestClient(app) as client:
        scene_job = completed_job(
            client,
            client.post(
                "/v1/floorplan-scenes",
                json={
                    "schemaVersion": "0.4",
                    "sourceImageUrl": analysis["sourceImageUrl"],
                    "imageWidth": analysis["imageWidth"],
                    "imageHeight": analysis["imageHeight"],
                    "planWidthMm": 8150,
                    "planDepthMm": 6060,
                    "detectedBounds": bounds,
                    "walls": analysis["wallCandidates"],
                    "semanticLayout": semantic,
                    "roomSelection": room_selection,
                    "roomName": "客餐厅",
                    "renderQuality": "preview",
                    "enableEnhancement": False,
                    "useBlender": False,
                },
            ),
        )

    scene = scene_job["result"]
    assert scene["schemaVersion"] == "0.4"
    assert scene["renderType"] == "semantic-dollhouse-v4"
    assert scene["structureCheck"]["semanticLayoutValidated"] is True
    assert scene["structureCheck"]["roomCount"] == 5
    assert scene["structureCheck"]["furnitureIsSuggestion"] is False


def test_v05_external_vision_accepts_arbitrary_one_room_plan(
    monkeypatch: MonkeyPatch,
) -> None:
    semantic_layout = {
        "version": "0.5",
        "profileId": "vision_arbitrary_studio",
        "sourceSha256": "fake-sha",
        "source": {
            "provider": "kuyao",
            "model": "gpt-5.6-sol",
            "promptVersion": "floorplan-q10000-v2-auto-dimensions",
        },
        "coordinateSystem": {
            "unit": "mm",
            "origin": "top_left",
            "xAxis": "right",
            "yAxis": "down",
        },
        "plan": {
            "widthMm": 6000,
            "depthMm": 4000,
            "ceilingHeightMm": 2800,
            "scaleStatus": "vision_estimated",
            "scaleConfidence": 0.91,
        },
        "rooms": [
            {
                "id": "room_studio",
                "type": "living_room",
                "name": "开间",
                "rect": {"xMm": 0, "yMm": 0, "widthMm": 6000, "depthMm": 4000},
                "polygon": [
                    {"xMm": 0, "yMm": 0},
                    {"xMm": 6000, "yMm": 0},
                    {"xMm": 6000, "yMm": 4000},
                    {"xMm": 0, "yMm": 4000},
                ],
                "confidence": 0.96,
            }
        ],
        "walls": [
            {
                "id": "wall_top",
                "kind": "exterior",
                "start": {"xMm": 0, "yMm": 0},
                "end": {"xMm": 6000, "yMm": 0},
                "thicknessMm": 120,
                "confidence": 0.97,
            },
            {
                "id": "wall_right",
                "kind": "exterior",
                "start": {"xMm": 6000, "yMm": 0},
                "end": {"xMm": 6000, "yMm": 4000},
                "thicknessMm": 120,
                "confidence": 0.97,
            },
            {
                "id": "wall_bottom",
                "kind": "exterior",
                "start": {"xMm": 6000, "yMm": 4000},
                "end": {"xMm": 0, "yMm": 4000},
                "thicknessMm": 120,
                "confidence": 0.97,
            },
            {
                "id": "wall_left",
                "kind": "exterior",
                "start": {"xMm": 0, "yMm": 4000},
                "end": {"xMm": 0, "yMm": 0},
                "thicknessMm": 120,
                "confidence": 0.97,
            },
        ],
        "openings": [],
        "furniture": [],
        "validation": {"status": "review_required", "errors": [], "warnings": []},
    }

    def fake_recognize(*_args, **_kwargs):
        return {
            "semantic_layout": semantic_layout,
            "drawing_bounds": {
                "coordinateSpace": "full_image_q10000",
                "xQ": 1000,
                "yQ": 1000,
                "widthQ": 8000,
                "depthQ": 8000,
            },
            "confidence": 0.95,
            "warnings": [],
            "provider": "kuyao",
            "model": "gpt-5.6-sol",
            "dimension_source": "dimension_chain",
            "dimension_confidence": 0.91,
            "dimension_evidence": ["6000 mm", "4000 mm"],
        }

    monkeypatch.setattr(settings, "floorplan_vision_provider", "kuyao")
    monkeypatch.setattr(settings, "kuyao_api_key", "test-only-secret")
    monkeypatch.setattr(
        "app.processors.floorplan.recognize_floorplan",
        fake_recognize,
    )

    with TestClient(app) as client:
        analysis_job = completed_job(
            client,
            client.post(
                "/v1/floorplans/analyze",
                files={"source_image": ("arbitrary.png", image_bytes(), "image/png")},
            ),
        )
        analysis = analysis_job["result"]
        assert analysis["schemaVersion"] == "0.5"
        assert analysis["quality"]["recognitionMode"] == "external-vision"
        assert analysis["quality"]["provider"] == "kuyao"
        assert analysis["planWidthMm"] == 6000
        assert analysis["planDepthMm"] == 4000
        assert analysis["quality"]["dimensionSource"] == "dimension_chain"
        assert analysis["semanticLayout"]["profileId"] == "vision_arbitrary_studio"
        assert len(analysis["wallCandidates"]) == 4

        bounds = analysis["detectedBounds"]
        scene_request = {
            "schemaVersion": "0.5",
            "sourceImageUrl": analysis["sourceImageUrl"],
            "imageWidth": analysis["imageWidth"],
            "imageHeight": analysis["imageHeight"],
            "planWidthMm": 6000,
            "planDepthMm": 4000,
            "detectedBounds": bounds,
            "walls": analysis["wallCandidates"],
            "semanticLayout": analysis["semanticLayout"],
            "roomSelection": bounds,
            "roomName": "开间",
            "renderQuality": "preview",
            "enableEnhancement": False,
            "useBlender": False,
        }
        unconfirmed_response = client.post("/v1/floorplan-scenes", json=scene_request)
        assert unconfirmed_response.status_code == 202
        unconfirmed_job = client.get(
            f"/v1/jobs/{unconfirmed_response.json()['id']}"
        ).json()
        assert unconfirmed_job["status"] == "FAILED"
        assert unconfirmed_job["errorCode"] == "INPUT_REJECTED"
        assert "确认结构" in unconfirmed_job["errorMessage"]

        scene_request["semanticReviewConfirmed"] = True
        scene_job = completed_job(
            client,
            client.post("/v1/floorplan-scenes", json=scene_request),
        )

    scene = scene_job["result"]
    assert scene["schemaVersion"] == "0.5"
    assert scene["renderType"] == "semantic-dollhouse-v5"
    assert scene["layoutMode"] == "vision-semantic-layout"
    assert scene["structureCheck"]["passed"] is True
    assert scene["structureCheck"]["topologyClosed"] is True


def test_floorplan_upload_rejects_oversized_pixel_canvas_before_decode() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/v1/floorplans/analyze",
            files={"source_image": ("bomb.png", oversized_png_header(), "image/png")},
            data={"plan_width_mm": "6000", "plan_depth_mm": "4000"},
        )

    assert response.status_code == 413
    assert "像素" in response.json()["detail"]


def test_semantic_quality_gate_warns_for_substantial_furniture_overlap() -> None:
    furniture = [
        {
            "id": "bed_one",
            "type": "bed",
            "center": {"xMm": 3000, "yMm": 2000},
            "size": {"widthMm": 1600, "depthMm": 2000},
            "rotationDeg": 0,
            "roomId": "room_main",
        },
        {
            "id": "wardrobe_one",
            "type": "wardrobe",
            "center": {"xMm": 3100, "yMm": 2000},
            "size": {"widthMm": 1400, "depthMm": 600},
            "rotationDeg": 0,
            "roomId": "room_main",
        },
    ]

    result = _semantic_structure_status(semantic_status_payload(furniture=furniture))

    assert result["passed"] is True
    assert result["furnitureCollisionFree"] is False
    assert result["furnitureCollisions"] == [["bed_one", "wardrobe_one"]]
    assert result["validationErrors"] == []
    assert "furniture_overlap" in result["validationWarnings"]


def test_semantic_quality_gate_warns_for_furniture_crossing_wall() -> None:
    furniture = [
        {
            "id": "cabinet_crossing_wall",
            "type": "wardrobe",
            "center": {"xMm": 3000, "yMm": 2000},
            "size": {"widthMm": 1000, "depthMm": 1000},
            "rotationDeg": 0,
            "roomId": "room_main",
        }
    ]

    result = _semantic_structure_status(
        semantic_status_payload(furniture=furniture, include_center_wall=True)
    )

    assert result["passed"] is True
    assert result["furnitureWallClear"] is False
    assert result["wallCollisionIds"] == ["cabinet_crossing_wall"]
    assert result["validationErrors"] == []
    assert "furniture_wall_collision" in result["validationWarnings"]


def test_semantic_quality_gate_allows_furniture_flush_against_wall() -> None:
    furniture = [
        {
            "id": "cabinet_against_top_wall",
            "type": "wardrobe",
            "center": {"xMm": 3000, "yMm": 300},
            "size": {"widthMm": 1000, "depthMm": 600},
            "rotationDeg": 0,
            "roomId": "room_main",
        }
    ]

    result = _semantic_structure_status(semantic_status_payload(furniture=furniture))

    assert result["passed"] is True
    assert result["furnitureWallClear"] is True
    assert result["wallCollisionIds"] == []
    assert "furniture_wall_collision" not in result["validationWarnings"]


def test_opening_off_wall_is_reported_as_non_blocking_warning() -> None:
    opening = {
        "id": "door_bottom",
        "type": "door",
        "wallAxis": "horizontal",
        "segment": {
            "start": {"xMm": 2500, "yMm": 4000},
            "end": {"xMm": 3500, "yMm": 4000},
        },
        "roomIds": ["room_main"],
    }

    result = _semantic_structure_status(semantic_status_payload(openings=[opening]))

    assert result["passed"] is True
    assert result["openingsOnWalls"] is False
    assert result["validationErrors"] == []
    assert "opening_not_on_wall" in result["validationWarnings"]


def test_open_wall_chain_is_reported_as_non_blocking_warning() -> None:
    payload = semantic_status_payload()
    right_wall = payload["semantic_layout"]["walls"][1]
    right_wall["end"]["yMm"] = 3500
    pixel_right_wall = payload["walls"][1]
    pixel_right_wall["y2"] = 350

    result = _semantic_structure_status(payload)

    assert result["passed"] is True
    assert result["topologyClosed"] is False
    assert result["validationErrors"] == []
    assert "wall_topology_not_closed" in result["validationWarnings"]


def test_furniture_crossing_room_boundary_is_non_blocking_warning() -> None:
    furniture = [
        {
            "id": "wardrobe_crossing_room_boundary",
            "type": "wardrobe",
            "center": {"xMm": 200, "yMm": 2000},
            "size": {"widthMm": 1200, "depthMm": 600},
            "rotationDeg": 0,
            "roomId": "room_main",
        }
    ]

    result = _semantic_structure_status(semantic_status_payload(furniture=furniture))

    assert result["passed"] is True
    assert result["furniturePlacementValid"] is False
    assert result["validationErrors"] == []
    assert "invalid_furniture_placement" in result["validationWarnings"]


def test_scene_validation_continues_with_reviewable_semantic_warnings() -> None:
    opening = {
        "id": "door_bottom",
        "type": "door",
        "wallAxis": "horizontal",
        "segment": {
            "start": {"xMm": 2500, "yMm": 4000},
            "end": {"xMm": 3500, "yMm": 4000},
        },
        "roomIds": ["room_main"],
    }
    furniture = [
        {
            "id": "cabinet_crossing_wall",
            "type": "wardrobe",
            "center": {"xMm": 3000, "yMm": 2000},
            "size": {"widthMm": 1000, "depthMm": 1000},
            "rotationDeg": 0,
            "roomId": "room_main",
        }
    ]
    payload = semantic_status_payload(
        furniture=furniture,
        openings=[opening],
        include_center_wall=True,
    )
    payload["room_selection"] = {"x": 0, "y": 0, "width": 600, "height": 400}

    result = _validate_scene(payload)

    assert result["passed"] is True
    assert result["validationErrors"] == []
    assert set(result["validationWarnings"]) == {
        "opening_not_on_wall",
        "furniture_wall_collision",
    }


def test_topology_closes_when_opening_chain_has_small_vision_coordinate_drift() -> None:
    opening = {
        "id": "window_top",
        "type": "window",
        "wallAxis": "horizontal",
        "segment": {
            "start": {"xMm": 2504, "yMm": 4},
            "end": {"xMm": 3496, "yMm": 4},
        },
        "roomIds": ["room_main"],
    }
    payload = semantic_status_payload(openings=[opening])
    walls = [
        {
            "id": "wall_top_left",
            "kind": "exterior",
            "start": {"xMm": 0, "yMm": 0},
            "end": {"xMm": 2500, "yMm": 0},
            "thicknessMm": 100,
        },
        {
            "id": "wall_top_right",
            "kind": "exterior",
            "start": {"xMm": 3500, "yMm": 0},
            "end": {"xMm": 6000, "yMm": 0},
            "thicknessMm": 100,
        },
        *payload["semantic_layout"]["walls"][1:],
    ]
    payload["semantic_layout"]["walls"] = walls
    payload["walls"] = [
        {
            "id": wall["id"],
            "x1": wall["start"]["xMm"] / 10,
            "y1": wall["start"]["yMm"] / 10,
            "x2": wall["end"]["xMm"] / 10,
            "y2": wall["end"]["yMm"] / 10,
            "source": "semantic",
        }
        for wall in walls
    ]

    result = _semantic_structure_status(payload)

    assert result["passed"] is True
    assert result["topologyClosed"] is True
    assert result["openingsOnWalls"] is True


def test_malformed_semantic_layout_maps_to_input_rejected() -> None:
    payload = semantic_status_payload()
    payload["room_selection"] = {"x": 0, "y": 0, "width": 600, "height": 400}
    payload["semantic_layout"] = {"version": "0.5", "plan": "malformed"}

    with pytest.raises(ProcessorError) as error:
        _validate_scene(payload)

    assert error.value.code == "INPUT_REJECTED"
    assert "invalid_semantic_layout" in error.value.message


def test_v05_confirmed_scene_still_requires_semantic_layout() -> None:
    payload = semantic_status_payload()
    payload["schema_version"] = "0.5"
    payload["semantic_review_confirmed"] = True
    payload["room_selection"] = {"x": 0, "y": 0, "width": 600, "height": 400}
    payload["semantic_layout"] = None

    with pytest.raises(ProcessorError) as error:
        _validate_scene(payload)

    assert error.value.code == "INPUT_REJECTED"
    assert "semanticLayout" in error.value.message


def test_ai_direct_scene_skips_blender_and_reports_generation_mode(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    source_path = tmp_path / "direct-source.png"
    source = cv2.imdecode(np.frombuffer(image_bytes(), np.uint8), cv2.IMREAD_COLOR)
    assert source is not None
    assert cv2.imwrite(str(source_path), source)

    payload = semantic_status_payload()
    payload.update(
        {
            "source_image_url": "/artifacts/direct-source.png",
            "image_width": 640,
            "image_height": 420,
            "room_selection": payload["detected_bounds"],
            "room_name": "AI 直出测试",
            "ceiling_height_mm": 2800,
            "wall_thickness_mm": 100,
            "style_preset_id": "modern_warm_v1",
            "generation_mode": "ai_direct",
            "render_quality": "final",
            "enable_enhancement": True,
            "enhancement_strength": 0.62,
            "enhancement_seed": 17,
            "use_blender": True,
        }
    )

    def fail_blender(*_args, **_kwargs):
        raise AssertionError("AI direct mode must not start Blender")

    def fake_direct(source_reference: Path, semantic_reference: Path, _payload: dict):
        assert source_reference.is_file()
        assert semantic_reference.is_file()
        candidate_path = tmp_path / "direct-final.png"
        candidate = cv2.imread(str(source_reference))
        assert candidate is not None
        assert cv2.imwrite(str(candidate_path), candidate)
        return {
            "path": candidate_path,
            "url": "/artifacts/direct-final.png",
            "provider": "kuyao-gpt-image-2",
            "modelRevision": "gpt-image-2",
            "notice": "direct test",
            "requested": True,
            "seed": 17,
            "seedMode": "audit-only",
            "mode": "kuyao-ai-direct",
            "controlImage": "source-floorplan+semantic-layout",
            "controlModel": None,
            "rejectedProvider": None,
            "consistency": {
                "inputSizeMatches": True,
                "outputSizeMatches": True,
                "edgeRetention": 0.95,
                "layoutDriftScore": 0.05,
                "passed": True,
                "registrationApplied": False,
                "registrationMode": "test-direct",
            },
        }

    monkeypatch.setattr(
        "app.processors.floorplan.render_floorplan_with_blender",
        fail_blender,
    )
    monkeypatch.setattr(
        "app.processors.floorplan.generate_direct_floorplan_render",
        fake_direct,
    )

    result = run_floorplan_scene(payload)

    assert result["generationMode"] == "ai_direct"
    assert result["renderType"] == "semantic-ai-direct-v5"
    assert result["provider"] == "kuyao-gpt-image-2"
    assert result["enhancement"]["mode"] == "kuyao-ai-direct"
    assert result["structureCheck"]["passed"] is True
    assert result["renderInfo"]["samples"] == 0


def test_ai_direct_references_preserve_source_aspect_ratio(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    source_path = tmp_path / "near-square-plan.png"
    source = np.zeros((800, 851, 3), dtype=np.uint8)
    assert cv2.imwrite(str(source_path), source)
    payload = semantic_status_payload()
    payload.update(
        {
            "image_width": 851,
            "image_height": 800,
            "detected_bounds": {"x": 0, "y": 0, "width": 851, "height": 800},
        }
    )

    source_reference_path, semantic_path, reference = _direct_reference_images(
        payload,
        source_path,
    )

    assert source_reference_path.is_file()
    assert semantic_path.is_file()
    assert reference.shape[:2] == (1024, 1536)
    content_mask = np.any(reference < 250, axis=2).astype(np.uint8)
    x, y, width, height = cv2.boundingRect(content_mask)
    assert x > 0
    assert y == 0
    assert height == 1024
    assert width / height == pytest.approx(851 / 800, abs=0.002)


def test_floorplan_scene_wall_limit_matches_vision_contract() -> None:
    walls = [
        {
            "id": f"wall_{index}",
            "x1": 0,
            "y1": index,
            "x2": 600,
            "y2": index,
            "source": "semantic",
        }
        for index in range(501)
    ]
    request = {
        "source_image_url": "/artifacts/plan.png",
        "image_width": 600,
        "image_height": 400,
        "plan_width_mm": 6000,
        "plan_depth_mm": 4000,
        "detected_bounds": {"x": 0, "y": 0, "width": 600, "height": 400},
        "walls": walls[:500],
        "room_selection": {"x": 0, "y": 0, "width": 600, "height": 400},
    }

    assert len(FloorplanSceneRequest.model_validate(request).walls) == 500
    request["walls"] = walls
    with pytest.raises(ValidationError):
        FloorplanSceneRequest.model_validate(request)


def test_blender_semantics_has_proxy_fallback_and_realistic_door_height() -> None:
    script_path = (
        Path(__file__).resolve().parents[1]
        / "app"
        / "processors"
        / "blender_floorplan_scene.py"
    )
    script = script_path.read_text(encoding="utf-8")

    assert "def add_semantic_proxy(" in script
    assert "else:\n            add_semantic_proxy(name, item, center, rotation_z)" in script
    assert "1.90,\n            2.40," in script


def test_structure_quality_gate_rejects_large_layout_drift() -> None:
    base = np.full((320, 480, 3), 245, dtype=np.uint8)
    candidate = base.copy()
    cv2.rectangle(base, (80, 60), (400, 260), (35, 35, 35), 6)
    cv2.rectangle(candidate, (115, 85), (435, 285), (35, 35, 35), 6)
    result = structure_consistency(base, candidate)
    assert result["passed"] is False
    assert result["edgeRetention"] < 0.72


def test_structure_quality_gate_allows_small_rendering_edge_shift() -> None:
    base = np.full((320, 480, 3), 245, dtype=np.uint8)
    candidate = base.copy()
    cv2.rectangle(base, (80, 60), (400, 260), (35, 35, 35), 6)
    cv2.rectangle(candidate, (85, 65), (405, 265), (35, 35, 35), 6)

    strict = structure_consistency(base, candidate, tolerance_px=4)
    realistic = structure_consistency(base, candidate, tolerance_px=6)

    assert strict["edgeRetention"] < realistic["edgeRetention"]
    assert realistic["passed"] is True


def _semantic_registration_fixture(
    *,
    partition_y: int = 150,
) -> tuple[np.ndarray, np.ndarray]:
    image = np.full((360, 480, 3), 255, dtype=np.uint8)
    cv2.rectangle(image, (40, 30), (440, 330), (35, 35, 35), 8)
    cv2.line(image, (40, partition_y), (440, partition_y), (35, 35, 35), 8)
    cv2.line(image, (260, 30), (260, partition_y), (35, 35, 35), 8)
    cv2.rectangle(image, (90, 190), (180, 250), (90, 90, 90), 4)

    semantic = np.full_like(image, 184)
    wall_color = (246, 184, 118)
    cv2.rectangle(semantic, (40, 30), (440, 330), wall_color, 12)
    cv2.line(semantic, (40, 150), (440, 150), wall_color, 12)
    cv2.line(semantic, (260, 30), (260, 150), wall_color, 12)
    return image, semantic


def _perspective_candidate(image: np.ndarray) -> np.ndarray:
    source = np.float32([[40, 30], [440, 30], [440, 330], [40, 330]])
    target = np.float32([[62, 20], [470, 34], [505, 365], [24, 348]])
    transform = cv2.getPerspectiveTransform(source, target)
    return cv2.warpPerspective(
        image,
        transform,
        (530, 390),
        borderValue=(255, 255, 255),
    )


def test_semantic_wall_registration_allows_global_camera_transform() -> None:
    base, semantic = _semantic_registration_fixture()
    candidate = _perspective_candidate(base)

    result = structure_consistency(
        base,
        candidate,
        tolerance_px=4,
        semantic_control=semantic,
    )

    assert result["inputSizeMatches"] is False
    assert result["outputSizeMatches"] is True
    assert result["registrationApplied"] is True
    assert result["registrationMode"] == "semantic-wall-homography"
    assert result["semanticWallRetention"] >= 0.95
    assert result["localWallRetention"] >= 0.9
    assert result["passed"] is True


def test_semantic_wall_registration_rejects_local_partition_drift() -> None:
    base, semantic = _semantic_registration_fixture()
    changed, _ = _semantic_registration_fixture(partition_y=205)
    candidate = _perspective_candidate(changed)

    result = structure_consistency(
        base,
        candidate,
        tolerance_px=4,
        semantic_control=semantic,
    )

    assert result["registrationApplied"] is True
    assert result["semanticWallRetention"] >= 0.75
    assert result["localWallRetention"] < 0.6
    assert result["passed"] is False


def test_semantic_registration_rejects_excessive_global_scale() -> None:
    base, semantic = _semantic_registration_fixture()
    excessively_wide = cv2.resize(base, (900, 360), interpolation=cv2.INTER_LINEAR)

    result = structure_consistency(
        base,
        excessively_wide,
        tolerance_px=4,
        semantic_control=semantic,
    )

    assert result["registrationApplied"] is False
    assert result["registrationMode"] == "semantic-wall-registration-rejected"
    assert result["passed"] is False


def test_ai_direct_uses_homography_for_audit_without_warping_output(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    base, semantic = _semantic_registration_fixture()
    candidate = _perspective_candidate(base)
    base_path = tmp_path / "direct-base.png"
    semantic_path = tmp_path / "direct-semantic.png"
    candidate_path = tmp_path / "direct-candidate.png"
    assert cv2.imwrite(str(base_path), base)
    assert cv2.imwrite(str(semantic_path), semantic)
    assert cv2.imwrite(str(candidate_path), candidate)

    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    monkeypatch.setattr(settings, "floorplan_final_image_provider", "auto")
    monkeypatch.setattr(settings, "kuyao_api_key", "test-only-secret")
    monkeypatch.setattr(
        "app.processors.floorplan_enhancement.edit_floorplan_image",
        lambda *_args, **_kwargs: {
            "path": str(candidate_path),
            "url": "/artifacts/direct-candidate.png",
            "model": "gpt-image-2",
        },
    )

    result = generate_direct_floorplan_render(
        base_path,
        semantic_path,
        {
            "semantic_layout": semantic_status_payload()["semantic_layout"],
            "enhancement_strength": 0.62,
            "enhancement_seed": 17,
        },
    )

    published = cv2.imread(str(result["path"]))
    assert published is not None
    assert result["consistency"]["auditRegistrationApplied"] is True
    assert result["consistency"]["registrationApplied"] is False
    assert result["consistency"]["registrationMode"] == "semantic-wall-audit-only"
    assert result["consistency"]["outputTransformApplied"] is False
    assert published.shape[:2] == base.shape[:2]

    scale = min(base.shape[1] / candidate.shape[1], base.shape[0] / candidate.shape[0])
    fitted_width = round(candidate.shape[1] * scale)
    fitted_height = round(candidate.shape[0] * scale)
    fitted = cv2.resize(candidate, (fitted_width, fitted_height), interpolation=cv2.INTER_AREA)
    expected = np.full_like(base, 255)
    offset_x = (base.shape[1] - fitted_width) // 2
    offset_y = (base.shape[0] - fitted_height) // 2
    expected[offset_y : offset_y + fitted_height, offset_x : offset_x + fitted_width] = fitted
    assert np.array_equal(published, expected)


def test_enhancement_capability_reports_degraded_comfyui(
    monkeypatch: MonkeyPatch,
) -> None:
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self, _limit: int) -> bytes:
            return (
                b'{"status":"degraded","provider":"comfyui",'
                b'"mode":"sdxl-img2img",'
                b'"capabilities":{"controlNetReady":false},'
                b'"detail":"ControlNet model is not installed"}'
            )

    monkeypatch.setattr(
        settings,
        "floorplan_ai_endpoint",
        "http://127.0.0.1:8189/v1/enhance",
    )
    monkeypatch.setattr(
        "app.processors.floorplan_enhancement.urllib.request.urlopen",
        lambda _request, timeout: FakeResponse(),
    )

    capability = enhancement_capability()
    assert capability["configured"] is True
    assert capability["reachable"] is True
    assert capability["provider"] == "comfyui"
    assert capability["mode"] == "sdxl-img2img"
    assert capability["controlNetReady"] is False


def test_final_enhancement_prefers_configured_kuyao(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    base = np.full((240, 320, 3), 235, dtype=np.uint8)
    cv2.rectangle(base, (40, 35), (280, 205), (40, 40, 40), 5)
    base_path = tmp_path / "base.png"
    candidate_path = tmp_path / "candidate.png"
    assert cv2.imwrite(str(base_path), base)
    assert cv2.imwrite(str(candidate_path), base)

    calls: list[dict] = []

    def fake_edit(_source_path, **kwargs):
        calls.append(kwargs)
        return {
            "path": str(candidate_path),
            "url": "/artifacts/candidate.png",
            "model": "gpt-image-2",
        }

    monkeypatch.setattr(settings, "floorplan_final_image_provider", "auto")
    monkeypatch.setattr(settings, "kuyao_api_key", "test-only-secret")
    monkeypatch.setattr(settings, "floorplan_ai_endpoint", "")
    monkeypatch.setattr(
        "app.processors.floorplan_enhancement.edit_floorplan_image",
        fake_edit,
    )

    result = enhance_floorplan_render(
        base_path,
        {},
        {
            "render_quality": "final",
            "enable_enhancement": True,
            "enhancement_strength": 0.62,
            "enhancement_seed": 17,
            "style_preset_id": "modern_warm_v1",
        },
    )

    assert len(calls) == 1
    assert calls[0]["model"] == "gpt-image-2"
    assert calls[0]["quality"] == "high"
    assert "Visual restyling strength is 62%" in calls[0]["prompt"]
    assert "never layout or geometry" in calls[0]["prompt"]
    assert result["provider"] == "kuyao-gpt-image-2"
    assert result["mode"] == "kuyao-image-edit"
    assert result["seedMode"] == "audit-only"
    assert "seed 仅作为审计元数据" in result["notice"]
    assert result["consistency"]["passed"] is True


def test_final_enhancement_publishes_semantically_registered_candidate(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    base, semantic = _semantic_registration_fixture()
    candidate = _perspective_candidate(base)
    base_path = tmp_path / "base.png"
    semantic_path = tmp_path / "semantic.png"
    candidate_path = tmp_path / "candidate.png"
    assert cv2.imwrite(str(base_path), base)
    assert cv2.imwrite(str(semantic_path), semantic)
    assert cv2.imwrite(str(candidate_path), candidate)

    monkeypatch.setattr(settings, "floorplan_final_image_provider", "auto")
    monkeypatch.setattr(settings, "kuyao_api_key", "test-only-secret")
    monkeypatch.setattr(settings, "floorplan_ai_endpoint", "")
    monkeypatch.setattr(
        "app.processors.floorplan_enhancement.edit_floorplan_image",
        lambda *_args, **_kwargs: {
            "path": str(candidate_path),
            "url": "/artifacts/candidate.png",
            "model": "gpt-image-2",
        },
    )

    result = enhance_floorplan_render(
        base_path,
        {"semantic": semantic_path},
        {
            "render_quality": "final",
            "enable_enhancement": True,
            "enhancement_strength": 0.62,
            "enhancement_seed": 17,
        },
    )

    published = cv2.imread(str(result["path"]))
    assert result["provider"] == "kuyao-gpt-image-2"
    assert result["rejectedProvider"] is None
    assert result["consistency"]["registrationMode"] == "semantic-wall-homography"
    assert result["consistency"]["inputSizeMatches"] is False
    assert result["consistency"]["passed"] is True
    assert published.shape[:2] == base.shape[:2]


def test_failed_kuyao_structure_gate_falls_back_and_records_provider(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    base = np.full((240, 320, 3), 235, dtype=np.uint8)
    cv2.rectangle(base, (40, 35), (280, 205), (40, 40, 40), 5)
    changed = np.full_like(base, 235)
    base_path = tmp_path / "base.png"
    candidate_path = tmp_path / "changed.png"
    assert cv2.imwrite(str(base_path), base)
    assert cv2.imwrite(str(candidate_path), changed)

    monkeypatch.setattr(settings, "floorplan_final_image_provider", "auto")
    monkeypatch.setattr(settings, "kuyao_api_key", "test-only-secret")
    monkeypatch.setattr(settings, "floorplan_ai_endpoint", "")
    monkeypatch.setattr(
        "app.processors.floorplan_enhancement.edit_floorplan_image",
        lambda *_args, **_kwargs: {
            "path": str(candidate_path),
            "url": "/artifacts/changed.png",
            "model": "gpt-image-2",
        },
    )

    result = enhance_floorplan_render(
        base_path,
        {},
        {
            "render_quality": "final",
            "enable_enhancement": True,
            "enhancement_strength": 0.9,
            "enhancement_seed": 17,
            "style_preset_id": "modern_warm_v1",
        },
    )

    assert result["provider"] == "local-structure-preserving-v2"
    assert result["rejectedProvider"] == "kuyao-gpt-image-2"
    assert result["consistency"]["passed"] is True
    assert "已自动回退" in result["notice"]
    assert Path(result["path"]).read_bytes() != candidate_path.read_bytes()


def test_failed_comfyui_structure_gate_also_falls_back(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    base = np.full((240, 320, 3), 235, dtype=np.uint8)
    cv2.rectangle(base, (40, 35), (280, 205), (40, 40, 40), 5)
    changed = np.full_like(base, 235)
    base_path = tmp_path / "base.png"
    assert cv2.imwrite(str(base_path), base)

    monkeypatch.setattr(settings, "floorplan_final_image_provider", "comfyui")
    monkeypatch.setattr(settings, "floorplan_ai_endpoint", "http://127.0.0.1:8189/v1/enhance")
    monkeypatch.setattr(
        "app.processors.floorplan_enhancement._http_enhance",
        lambda *_args, **_kwargs: EnhancementResult(
            image=changed,
            provider="comfyui-sdxl-controlnet",
            model_revision="test-model",
            notice="test candidate",
            requested=True,
            seed=17,
            mode="controlled-generation",
            seed_mode="provider-parameter",
        ),
    )

    result = enhance_floorplan_render(
        base_path,
        {},
        {
            "render_quality": "final",
            "enable_enhancement": True,
            "enhancement_strength": 0.9,
            "enhancement_seed": 17,
        },
    )

    assert result["provider"] == "local-structure-preserving-v2"
    assert result["rejectedProvider"] == "comfyui-sdxl-controlnet"
    assert result["consistency"]["passed"] is True
