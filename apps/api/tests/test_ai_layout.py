from __future__ import annotations

import json
import hashlib
from pathlib import Path
from time import monotonic, sleep
from typing import Any

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from app.config import settings
from app.database import SessionLocal
from app.jobs import create_job
from app.main import app


def image_bytes() -> bytes:
    image = np.full((420, 640, 3), 255, dtype=np.uint8)
    cv2.rectangle(image, (45, 45), (595, 375), (35, 35, 35), 8)
    cv2.line(image, (320, 45), (320, 250), (35, 35, 35), 6)
    success, output = cv2.imencode(".png", image)
    assert success
    return output.tobytes()


def semantic_layout() -> dict[str, Any]:
    source_sha256 = hashlib.sha256(image_bytes()).hexdigest()
    return {
        "version": "0.5",
        "profileId": "stage01_confirmed_test",
        "sourceSha256": source_sha256,
        "coordinateSystem": {
            "unit": "mm",
            "origin": "top_left",
            "xAxis": "right",
            "yAxis": "down",
        },
        "plan": {"widthMm": 8150, "depthMm": 6060, "scaleStatus": "confirmed"},
        "validation": {"status": "human_confirmed", "humanConfirmed": True},
        "rooms": [
            {
                "id": "room_living",
                "type": "living_room",
                "name": "客餐厅",
                "rect": {"xMm": 0, "yMm": 2600, "widthMm": 8150, "depthMm": 3460},
            },
            {
                "id": "room_bedroom",
                "type": "bedroom",
                "name": "主卧",
                "rect": {"xMm": 0, "yMm": 0, "widthMm": 3600, "depthMm": 2600},
            },
        ],
        "walls": [
            {
                "id": "wall_top",
                "kind": "exterior",
                "start": {"xMm": 0, "yMm": 0},
                "end": {"xMm": 8150, "yMm": 0},
                "thicknessMm": 120,
            }
        ],
        "openings": [
            {
                "id": "door_entry",
                "type": "door",
                "wallAxis": "horizontal",
                "segment": {
                    "start": {"xMm": 5700, "yMm": 6060},
                    "end": {"xMm": 6600, "yMm": 6060},
                },
                "widthMm": 900,
            }
        ],
        "furniture": [
            {
                "id": "sofa_existing",
                "type": "sofa",
                "roomId": "room_living",
                "center": {"xMm": 3000, "yMm": 4200},
                "size": {"widthMm": 2200, "depthMm": 900},
                "rotationDeg": 0,
            }
        ],
    }


def stage01_form_fields(semantic: dict[str, Any] | None = None) -> dict[str, str]:
    semantic = semantic or semantic_layout()
    detected_bounds = {"x": 45, "y": 45, "width": 550, "height": 330}
    with SessionLocal() as session:
        job = create_job(
            session,
            job_type="FLOORPLAN_ANALYZE",
            payload={"source_path": "stage01-test.png"},
        )
        job.status = "SUCCEEDED"
        job.progress = 1.0
        job.result = {
            "semanticLayout": semantic,
            "detectedBounds": detected_bounds,
        }
        session.commit()
        job_id = job.id
    return {
        "semantic_layout": json.dumps({"semanticLayout": semantic}, ensure_ascii=False),
        "stage01_analysis_job_id": job_id,
        "stage01_approved_version_id": f"{job_id}:test-approved",
        "stage01_source_sha256": str(semantic.get("sourceSha256") or ""),
        "stage01_detected_bounds": json.dumps(detected_bounds),
    }


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
    job_id = response.json()["id"]
    # C4 后任务在独立线程池异步执行：轮询直到终态
    deadline = monotonic() + 30.0
    value: dict[str, Any] = {}
    while monotonic() < deadline:
        job = client.get(f"/v1/jobs/{job_id}")
        assert job.status_code == 200
        value = job.json()
        if value["status"] in {"SUCCEEDED", "FAILED", "CANCELED"}:
            break
        sleep(0.05)
    assert value["status"] == "SUCCEEDED", value
    return value


def test_ai_layout_requires_approved_stage01_inputs(
    mock_ai_layout: list[dict[str, Any]],
) -> None:
    with TestClient(app) as client:
        missing_source = client.post(
            "/v1/layouts/ai",
            data={
                **stage01_form_fields(),
                "room_type": "whole_home",
                "count": "2",
            },
        )
        missing_semantic = client.post(
            "/v1/layouts/ai",
            files={"source_image": ("stage01.png", image_bytes(), "image/png")},
            data={"room_type": "whole_home", "count": "1"},
        )

    assert missing_source.status_code == 422
    assert missing_semantic.status_code == 422
    assert mock_ai_layout == []


def test_ai_layout_uses_only_stage01_project_inputs(
    mock_ai_layout: list[dict[str, Any]],
) -> None:
    source = image_bytes()
    semantic = semantic_layout()
    fields = stage01_form_fields(semantic)
    with TestClient(app) as client:
        job = completed_job(
            client,
            client.post(
                "/v1/layouts/ai",
                files={"source_image": ("custom-plan.png", source, "image/png")},
                data={
                    **fields,
                    "room_type": "bedroom",
                    "count": "2",
                    "design_prompt": "需要双人床和整墙衣柜",
                },
            ),
        )

    result = job["result"]
    assert result["sourceMode"] == "stage01_confirmed_annotation"
    assert result["count"] == 2
    assert result["promptVersion"] == "ai-professional-plan-v3-stage01-only"
    assert result["generationGoal"] == "professional_black_white_floor_plan"
    assert result["referencePolicy"] == "stage01_only"
    assert result["referenceImageCount"] == 0
    assert result["inputRoles"] == {
        "image1": "stage01_annotated_project_authority",
        "referenceImages": "none",
        "semanticLayout": "confirmed_function_zone_and_structure_authority",
    }
    assert result["stage01Lineage"]["analysisJobId"] == fields[
        "stage01_analysis_job_id"
    ]
    assert job["parentJobId"] == fields["stage01_analysis_job_id"]
    assert result["stage01Lineage"]["approvedVersionId"] == fields[
        "stage01_approved_version_id"
    ]
    assert result["stage01ControlImageUrl"].startswith(
        "/artifacts/layout-ai-stage01-control-"
    )
    assert len(mock_ai_layout) == 2
    call = mock_ai_layout[0]
    assert call.get("reference_paths") in (None, [])
    assert call["source_path"].name.startswith("layout-ai-stage01-control-")
    assert call["source_path"].read_bytes() != source
    control = cv2.imread(str(call["source_path"]), cv2.IMREAD_COLOR)
    assert control is not None
    door_roi = control[368:382, 425:500]
    assert np.any((door_roi[:, :, 2] > 180) & (door_roi[:, :, 0] < 100))
    assert "confirmed Stage 01 project image" in call["prompt"]
    assert "No external floor-plan reference images" in call["prompt"]
    assert "reference examples only" not in call["prompt"]
    assert "professional black-and-white" in call["prompt"]
    assert "orange-red opening segments mark confirmed doors" in call["prompt"]
    assert "需要双人床" in call["prompt"]
    assert result["notice"].startswith("AI 生成的专业平面布局仍属于方案设计")


def test_ai_layout_persists_confirmed_semantics_and_uses_structure_lock(
    mock_ai_layout: list[dict[str, Any]],
) -> None:
    semantic = semantic_layout()
    fields = stage01_form_fields(semantic)
    with TestClient(app) as client:
        job = completed_job(
            client,
            client.post(
                "/v1/layouts/ai",
                files={"source_image": ("confirmed-plan.png", image_bytes(), "image/png")},
                data={
                    **fields,
                    "room_type": "whole_home",
                    "count": "1",
                },
            ),
        )

    assert job["payload"]["semantic_layout"] == semantic
    summary = job["result"]["semanticInput"]
    assert summary["profileId"] == "stage01_confirmed_test"
    assert summary["plan"] == {
        "widthMm": 8150,
        "depthMm": 6060,
        "scaleStatus": "confirmed",
    }
    assert summary["counts"] == {
        "rooms": 2,
        "walls": 1,
        "openings": 1,
        "furniture": 1,
    }
    assert summary["roomIds"] == ["room_living", "room_bedroom"]
    assert summary["authoritativeSections"] == ["plan", "rooms", "walls", "openings"]
    assert summary["furnitureRole"] == "current_state_reference_only"
    assert len(summary["sha256"]) == 64
    assert job["result"]["inputRoles"]["semanticLayout"] == (
        "confirmed_function_zone_and_structure_authority"
    )

    prompt = mock_ai_layout[0]["prompt"]
    assert "STAGE 01 CONFIRMED SEMANTIC STRUCTURE LOCK" in prompt
    assert '"id":"room_living"' in prompt
    assert '"id":"wall_top"' in prompt
    assert '"id":"door_entry"' in prompt
    assert "FURNITURE ROLE" in prompt
    assert "not structurally locked" in prompt
    assert '"id":"sofa_existing"' in prompt
    assert "You may propose sensible internal room partitions" not in prompt


def test_ai_layout_rejects_invalid_stage01_semantic_layout(
    mock_ai_layout: list[dict[str, Any]],
) -> None:
    fields = stage01_form_fields()
    with TestClient(app) as client:
        malformed = client.post(
            "/v1/layouts/ai",
            files={"source_image": ("stage01.png", image_bytes(), "image/png")},
            data={
                **fields,
                "room_type": "whole_home",
                "semantic_layout": "{not-json}",
            },
        )
        empty_rooms = client.post(
            "/v1/layouts/ai",
            files={"source_image": ("stage01.png", image_bytes(), "image/png")},
            data={
                **fields,
                "room_type": "whole_home",
                "semantic_layout": json.dumps({"rooms": []}),
            },
        )

    assert malformed.status_code == 422
    assert "有效 JSON" in malformed.json()["detail"]
    assert empty_rooms.status_code == 422
    assert "rooms" in empty_rooms.json()["detail"]
    assert mock_ai_layout == []


def test_ai_layout_rejects_stage01_lineage_mismatches(
    mock_ai_layout: list[dict[str, Any]],
) -> None:
    source = image_bytes()
    fields = stage01_form_fields()
    different_hash = "a" * 64
    changed_semantic = semantic_layout()
    changed_semantic["sourceSha256"] = different_hash
    with TestClient(app) as client:
        hash_mismatch = client.post(
            "/v1/layouts/ai",
            files={"source_image": ("stage01.png", source, "image/png")},
            data={**fields, "stage01_source_sha256": different_hash},
        )
        semantic_mismatch = client.post(
            "/v1/layouts/ai",
            files={"source_image": ("stage01.png", source, "image/png")},
            data={
                **fields,
                "semantic_layout": json.dumps(changed_semantic),
                "stage01_source_sha256": different_hash,
            },
        )
        bounds_mismatch = client.post(
            "/v1/layouts/ai",
            files={"source_image": ("stage01.png", source, "image/png")},
            data={
                **fields,
                "stage01_detected_bounds": json.dumps(
                    {"x": 0, "y": 0, "width": 640, "height": 420}
                ),
            },
        )

    assert hash_mismatch.status_code == 422
    assert "同一版本" in hash_mismatch.json()["detail"]
    assert semantic_mismatch.status_code == 422
    assert "同一版本" in semantic_mismatch.json()["detail"]
    assert bounds_mismatch.status_code == 422
    assert "标注边界" in bounds_mismatch.json()["detail"]
    assert mock_ai_layout == []


def test_ai_layout_ignores_legacy_template_field_and_sends_no_references(
    mock_ai_layout: list[dict[str, Any]],
) -> None:
    fields = stage01_form_fields()
    with TestClient(app) as client:
        job = completed_job(
            client,
            client.post(
                "/v1/layouts/ai",
                files={"source_image": ("stage01.png", image_bytes(), "image/png")},
                data={
                    **fields,
                    "room_type": "living_room",
                    "count": "1",
                    "template_ids": "builtin_floorplan_01,unknown_template",
                },
            ),
        )

    assert job["result"]["referencePolicy"] == "stage01_only"
    assert job["result"]["referenceImageCount"] == 0
    assert len(mock_ai_layout) == 1
    assert mock_ai_layout[0].get("reference_paths") in (None, [])


def test_ai_layout_validates_room_type_and_count(
    mock_ai_layout: list[dict[str, Any]],
) -> None:
    fields = stage01_form_fields()
    with TestClient(app) as client:
        invalid_room = client.post(
            "/v1/layouts/ai",
            files={"source_image": ("stage01.png", image_bytes(), "image/png")},
            data={**fields, "room_type": "garage"},
        )
        invalid_count = client.post(
            "/v1/layouts/ai",
            files={"source_image": ("stage01.png", image_bytes(), "image/png")},
            data={
                **fields,
                "room_type": "living_room",
                "count": "3",
            },
        )

    assert invalid_room.status_code == 422
    assert invalid_count.status_code == 422
    assert mock_ai_layout == []
