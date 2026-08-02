from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from app.config import WORKSPACE_ROOT, settings
from app.main import app


def image_bytes() -> bytes:
    image = np.full((420, 640, 3), 255, dtype=np.uint8)
    cv2.rectangle(image, (45, 45), (595, 375), (35, 35, 35), 8)
    cv2.line(image, (320, 45), (320, 250), (35, 35, 35), 6)
    success, output = cv2.imencode(".png", image)
    assert success
    return output.tobytes()


@pytest.fixture
def mock_ai_layout(monkeypatch: MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(settings, "floorplan_final_image_provider", "auto")
    monkeypatch.setattr(settings, "kuyao_api_key", "test-only-key")
    monkeypatch.setattr(settings, "openai_api_key", "")
    monkeypatch.setattr(settings, "kuyao_image_model", "gpt-image-2")

    def fake_edit(source_path: Path, **kwargs: Any) -> dict[str, Any]:
        source = Path(source_path)
        assert source.is_file()
        output = settings.artifact_dir / f"ai-layout-mock-{len(calls) + 1}.png"
        output.write_bytes(image_bytes())
        calls.append({"source_path": source, **kwargs})
        return {
            "path": str(output),
            "url": f"/artifacts/{output.name}",
            "provider": "mock-kuyao",
            "model": kwargs["model"],
        }

    monkeypatch.setattr("app.processors.layout.edit_floorplan_image", fake_edit)
    return calls


def completed_job(client: TestClient, response) -> dict[str, Any]:
    assert response.status_code == 202, response.text
    job = client.get(f"/v1/jobs/{response.json()['id']}")
    assert job.status_code == 200
    value = job.json()
    assert value["status"] == "SUCCEEDED", value
    return value


def test_ai_layout_without_source_builds_proportional_authority_image(
    mock_ai_layout: list[dict[str, Any]],
) -> None:
    with TestClient(app) as client:
        job = completed_job(
            client,
            client.post(
                "/v1/layouts/ai",
                data={
                    "room_type": "whole_home",
                    "width_mm": "8150",
                    "depth_mm": "6060",
                    "count": "2",
                    "design_prompt": "两室一厅，收纳充足，动静分区",
                },
            ),
        )

    assert job["type"] == "LAYOUT_AI"
    result = job["result"]
    assert result["generationMode"] == "ai_image"
    assert result["sourceMode"] == "generated_rectangle"
    assert result["count"] == 2
    assert result["provider"] == "mock-kuyao"
    assert result["model"] == "gpt-image-2"
    assert result["isConceptOnly"] is True
    assert result["constructionReady"] is False
    assert result["requiresUserConfirmation"] is True
    assert result["templateIds"] == [
        "builtin_floorplan_01",
        "builtin_floorplan_02",
        "builtin_floorplan_03",
    ]
    assert result["templateVersion"] == "builtin-floorplans-v1"
    assert result["promptVersion"] == "ai-concept-layout-v1"
    assert result["inputRoles"] == {
        "image1": "geometry_authority",
        "referenceImages": "inspiration_only",
    }
    assert result["structureAudit"]["performed"] is False
    assert result["structureAudit"]["geometryGuaranteed"] is False
    assert len(mock_ai_layout) == 2

    expected_references = [
        WORKSPACE_ROOT / "example" / "平面图.jpeg",
        WORKSPACE_ROOT / "example" / "平面图2.jpeg",
        WORKSPACE_ROOT / "example" / "平面图3.jpeg",
    ]
    assert list(mock_ai_layout[0]["reference_paths"]) == expected_references
    assert mock_ai_layout[0]["size"] == "1536x1024"
    assert "image 1 is the sole geometric authority" in mock_ai_layout[0]["prompt"]
    assert "reference examples only" in mock_ai_layout[0]["prompt"]
    assert "Do not draw numerical dimensions" in mock_ai_layout[0]["prompt"]
    assert "两室一厅" in mock_ai_layout[0]["prompt"]

    authority = cv2.imread(str(mock_ai_layout[0]["source_path"]))
    assert authority is not None
    assert authority.shape[:2] == (1024, 1536)
    gray = cv2.cvtColor(authority, cv2.COLOR_BGR2GRAY)
    contours, _ = cv2.findContours(
        cv2.threshold(gray, 100, 255, cv2.THRESH_BINARY_INV)[1],
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE,
    )
    _, _, rectangle_width, rectangle_height = cv2.boundingRect(max(contours, key=cv2.contourArea))
    assert rectangle_width / rectangle_height == pytest.approx(8150 / 6060, rel=0.03)

    for layout in result["layouts"]:
        assert layout["previewUrl"].startswith("/artifacts/ai-layout-mock-")
        assert layout["generationMode"] == "ai_image"
        assert layout["provider"] == "mock-kuyao"
        assert layout["isConceptOnly"] is True
        assert layout["promptVersion"] == "ai-concept-layout-v1"
        assert "placements" not in layout
        assert "hardViolations" not in layout
        assert "metrics" not in layout


def test_ai_layout_upload_is_authoritative_and_examples_are_read_only(
    mock_ai_layout: list[dict[str, Any]],
) -> None:
    source = image_bytes()
    with TestClient(app) as client:
        job = completed_job(
            client,
            client.post(
                "/v1/layouts/ai",
                files={"source_image": ("custom-plan.png", source, "image/png")},
                data={
                    "room_type": "bedroom",
                    "width_mm": "4800",
                    "depth_mm": "3600",
                    "count": "1",
                    "design_prompt": "需要双人床和整墙衣柜",
                },
            ),
        )
        example = client.get("/examples/平面图.jpeg")

    assert example.status_code == 200
    assert example.headers["content-type"].startswith("image/jpeg")
    assert job["result"]["sourceMode"] == "uploaded"
    assert len(mock_ai_layout) == 1
    call = mock_ai_layout[0]
    assert call["source_path"].name.startswith("custom-plan-")
    assert call["source_path"].read_bytes() == source
    assert "uploaded floor plan" in call["prompt"]
    assert "Do not add, remove or move any wall" in call["prompt"]
    assert "需要双人床" in call["prompt"]
    assert job["result"]["notice"].startswith("AI 布局仅为概念设计建议")


def test_ai_layout_rejects_unknown_template_before_creating_job(
    mock_ai_layout: list[dict[str, Any]],
) -> None:
    with TestClient(app) as client:
        response = client.post(
            "/v1/layouts/ai",
            data={
                "room_type": "living_room",
                "width_mm": "5200",
                "depth_mm": "4200",
                "count": "1",
                "template_ids": "builtin_floorplan_01,unknown_template",
            },
        )

    assert response.status_code == 422
    assert "unknown_template" in response.json()["detail"]
    assert mock_ai_layout == []


def test_ai_layout_validates_room_type_and_count(
    mock_ai_layout: list[dict[str, Any]],
) -> None:
    with TestClient(app) as client:
        invalid_room = client.post(
            "/v1/layouts/ai",
            data={"room_type": "garage", "width_mm": "5200", "depth_mm": "4200"},
        )
        invalid_count = client.post(
            "/v1/layouts/ai",
            data={
                "room_type": "living_room",
                "width_mm": "5200",
                "depth_mm": "4200",
                "count": "3",
            },
        )

    assert invalid_room.status_code == 422
    assert invalid_count.status_code == 422
    assert mock_ai_layout == []
