from __future__ import annotations

import cv2
import numpy as np
from fastapi.testclient import TestClient

from app.main import app


def image_bytes() -> bytes:
    image = np.full((420, 640, 3), 255, dtype=np.uint8)
    cv2.rectangle(image, (45, 45), (595, 375), (128, 114, 107), 8)
    cv2.rectangle(image, (170, 180), (470, 300), (184, 163, 148), 5)
    success, output = cv2.imencode(".png", image)
    assert success
    return output.tobytes()


def completed_job(client: TestClient, response) -> dict:
    assert response.status_code == 202, response.text
    job_id = response.json()["id"]
    job = client.get(f"/v1/jobs/{job_id}")
    assert job.status_code == 200
    assert job.json()["status"] == "SUCCEEDED", job.json()
    return job.json()


def test_health_and_projects() -> None:
    with TestClient(app) as client:
        assert client.get("/health").json()["status"] == "ok"
        response = client.post(
            "/v1/projects",
            json={"name": "本地 MVP 测试项目"},
        )
        assert response.status_code == 201
        assert response.json()["name"] == "本地 MVP 测试项目"


def test_four_module_jobs() -> None:
    source = image_bytes()
    with TestClient(app) as client:
        layout = completed_job(
            client,
            client.post(
                "/v1/layouts",
                json={
                    "roomType": "living_room",
                    "widthMm": 5200,
                    "depthMm": 4200,
                    "count": 2,
                },
            ),
        )
        assert len(layout["result"]["layouts"]) == 2

        white = completed_job(
            client,
            client.post(
                "/v1/white-model-renders",
                files={"source_image": ("white.png", source, "image/png")},
                data={"style_preset_id": "modern_minimal_v1"},
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


def test_v02_floorplan_to_scene_flow() -> None:
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
        assert analysis["schemaVersion"] == "0.2"
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
                    "schemaVersion": "0.2",
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
                    "useBlender": False,
                },
            ),
        )
        scene = scene_job["result"]
        assert scene["provider"] == "local-floorplan-fallback"
        assert scene["room"]["name"] == "测试客厅"
        assert scene["structureCheck"]["wallCount"] == len(walls)
        assert scene["structureCheck"]["requiresUserConfirmation"] is True
