from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from app.config import settings
from app.main import app
from app.processors.common import ProcessorError
from app.processors.image import _letterbox_white_model, white_model_structure_audit


def white_model_bytes(*, width: int = 900, height: int = 650) -> bytes:
    image = np.full((height, width, 3), 248, dtype=np.uint8)
    cv2.rectangle(image, (35, 35), (width - 35, height - 35), (48, 48, 48), 8)
    cv2.line(image, (width // 2, 35), (width // 2, height - 35), (62, 62, 62), 6)
    cv2.line(image, (35, height // 2), (width - 35, height // 2), (62, 62, 62), 6)
    cv2.rectangle(image, (90, 90), (300, 230), (112, 112, 112), 5)
    cv2.rectangle(
        image,
        (width - 300, height - 230),
        (width - 90, height - 90),
        (112, 112, 112),
        5,
    )
    success, output = cv2.imencode(".png", image)
    assert success
    return output.tobytes()


def completed_job(client: TestClient, response) -> dict[str, Any]:
    assert response.status_code == 202, response.text
    job = client.get(f"/v1/jobs/{response.json()['id']}")
    assert job.status_code == 200
    return job.json()


def configure_ai(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "floorplan_final_image_provider", "auto")
    monkeypatch.setattr(settings, "kuyao_api_key", "test-only-key")
    monkeypatch.setattr(settings, "openai_api_key", "")
    monkeypatch.setattr(settings, "kuyao_image_model", "gpt-image-2")


@pytest.mark.parametrize(
    ("shape", "expected_size"),
    [
        ((650, 900), "1536x1024"),
        ((900, 650), "1024x1536"),
        ((700, 700), "1024x1024"),
    ],
)
def test_white_model_letterbox_preserves_aspect_without_crop(
    shape: tuple[int, int],
    expected_size: str,
) -> None:
    height, width = shape
    source = np.full((height, width, 3), 180, dtype=np.uint8)
    letterboxed, metadata, size = _letterbox_white_model(source)

    assert size == expected_size
    assert metadata["cropped"] is False
    assert metadata["anisotropicScaling"] is False
    assert metadata["contentWidth"] / metadata["contentHeight"] == pytest.approx(
        width / height,
        rel=0.002,
    )
    assert letterboxed.shape[1] == metadata["targetWidth"]
    assert letterboxed.shape[0] == metadata["targetHeight"]


def test_white_model_audit_uses_raw_pixel_space_and_rejects_drift() -> None:
    source = cv2.imdecode(np.frombuffer(white_model_bytes(), np.uint8), cv2.IMREAD_COLOR)
    assert source is not None
    authority, _, _ = _letterbox_white_model(source)

    passed = white_model_structure_audit(authority, authority.copy())
    assert passed["passed"] is True
    assert passed["allEdgeRecall"] >= 0.99
    assert passed["longEdgeRecall"] >= 0.99
    assert passed["localEdgeRecallQ20"] >= 0.99
    assert passed["newLongEdgeRatio"] <= 0.01
    assert passed["registrationApplied"] is False
    assert passed["outputTransformApplied"] is False
    assert passed["homographyApplied"] is False

    changed = np.full_like(authority, 255)
    cv2.line(changed, (40, 80), (authority.shape[1] - 40, 260), (25, 25, 25), 8)
    failed = white_model_structure_audit(authority, changed)
    assert failed["passed"] is False
    assert failed["edgeRetention"] < 0.72
    assert failed["outputTransformApplied"] is False
    assert failed["rawProviderOutput"] is True


def test_ai_quick_is_default_and_uses_three_style_only_references(
    monkeypatch: MonkeyPatch,
) -> None:
    configure_ai(monkeypatch)
    calls: list[dict[str, Any]] = []

    def fake_edit(source_path: Path, **kwargs: Any) -> dict[str, Any]:
        source = Path(source_path)
        output = settings.artifact_dir / "white-ai-provider-raw-pass.png"
        output.write_bytes(source.read_bytes())
        calls.append({"sourcePath": source, **kwargs})
        return {
            "path": str(output),
            "url": f"/artifacts/{output.name}",
            "provider": "mock-kuyao",
            "model": kwargs["model"],
        }

    monkeypatch.setattr("app.processors.image.edit_floorplan_image", fake_edit)
    source = white_model_bytes()
    files = [
        ("source_image", ("white.png", source, "image/png")),
        ("style_references", ("style-1.png", source, "image/png")),
        ("style_references", ("style-2.png", source, "image/png")),
        ("style_references", ("style-3.png", source, "image/png")),
    ]

    with TestClient(app) as client:
        job = completed_job(
            client,
            client.post(
                "/v1/white-model-renders",
                files=files,
                data={
                    "room_type": "living_room",
                    "style_preset_id": "modern_minimal_v1",
                    "prompt": "米白微水泥与自然天光",
                },
            ),
        )

    assert job["status"] == "SUCCEEDED", job
    assert job["payload"]["generation_mode"] == "ai_quick"
    assert len(calls) == 1
    call = calls[0]
    assert len(call["reference_paths"]) == 3
    assert all(Path(path).is_file() for path in call["reference_paths"])
    assert call["size"] == "1536x1024"
    assert "image 1 is the only geometric and camera authority" in call["prompt"]
    assert "style-only references" in call["prompt"]
    assert "never copy their geometry" in call["prompt"]
    assert "modern minimalist, restrained neutral palette" in call["prompt"]

    result = job["result"]
    assert result["generationMode"] == "ai_quick"
    assert result["provider"] == "mock-kuyao"
    assert result["model"] == "gpt-image-2"
    assert result["modelRevision"] == "gpt-image-2"
    assert result["promptVersion"] == "white-model-ai-quick-v1"
    assert result["inputRoles"] == {
        "image1": "white_model_geometry_camera_authority",
        "styleReferences": "style_only",
    }
    assert result["letterbox"]["cropped"] is False
    assert result["letterbox"]["anisotropicScaling"] is False
    assert result["structureAudit"]["passed"] is True
    assert result["structureAudit"]["outputTransformApplied"] is False
    assert result["outputs"][0]["url"].endswith("white-ai-provider-raw-pass.png")
    assert result["outputs"][0]["structureAudit"]["passed"] is True
    assert result["isConceptOnly"] is True
    assert result["constructionReady"] is False
    assert result["modelEditable"] is False
    assert result["requiresUserConfirmation"] is True


def test_ai_quick_failed_audit_keeps_raw_provider_image(
    monkeypatch: MonkeyPatch,
) -> None:
    configure_ai(monkeypatch)
    raw_output = settings.artifact_dir / "white-ai-provider-raw-failed.png"

    calls: list[dict[str, Any]] = []

    def fake_edit(source_path: Path, **kwargs: Any) -> dict[str, Any]:
        authority = cv2.imread(str(source_path))
        assert authority is not None
        changed = np.full_like(authority, 255)
        cv2.line(changed, (40, 80), (changed.shape[1] - 40, 260), (20, 20, 20), 8)
        assert cv2.imwrite(str(raw_output), changed)
        calls.append(kwargs)
        return {
            "path": str(raw_output),
            "url": f"/artifacts/{raw_output.name}",
            "provider": "mock-kuyao",
            "model": kwargs["model"],
        }

    monkeypatch.setattr("app.processors.image.edit_floorplan_image", fake_edit)
    with TestClient(app) as client:
        job = completed_job(
            client,
            client.post(
                "/v1/white-model-renders",
                files={
                    "source_image": ("white.png", white_model_bytes(), "image/png")
                },
            ),
        )

    assert job["status"] == "SUCCEEDED", job
    assert calls[0]["reference_paths"] == []
    result = job["result"]
    assert result["structureAudit"]["passed"] is False
    assert result["structureAudit"]["outputTransformApplied"] is False
    assert result["structureAudit"]["rawProviderOutput"] is True
    assert result["outputs"][0]["url"] == f"/artifacts/{raw_output.name}"
    assert raw_output.is_file()
    assert "不得视为结构正确" in result["notice"]


def test_ai_quick_unavailable_is_explicit_and_never_falls_back(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "floorplan_final_image_provider", "auto")
    monkeypatch.setattr(settings, "kuyao_api_key", "")
    monkeypatch.setattr(settings, "openai_api_key", "")
    monkeypatch.setattr(
        "app.processors.image.edit_floorplan_image",
        lambda *_args, **_kwargs: pytest.fail("unconfigured AI must not call the provider"),
    )

    with TestClient(app) as client:
        job = completed_job(
            client,
            client.post(
                "/v1/white-model-renders",
                files={
                    "source_image": ("white.png", white_model_bytes(), "image/png")
                },
            ),
        )

    assert job["status"] == "FAILED"
    assert job["errorCode"] == "AI_WHITE_MODEL_UNAVAILABLE"
    assert "gpt-image-2" in job["errorMessage"]
    assert job["result"] is None


def test_ai_quick_provider_failure_does_not_fall_back(
    monkeypatch: MonkeyPatch,
) -> None:
    configure_ai(monkeypatch)

    def fail_provider(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise ProcessorError("KUYAO_IMAGE_REQUEST_FAILED", "mock provider unavailable")

    monkeypatch.setattr("app.processors.image.edit_floorplan_image", fail_provider)
    with TestClient(app) as client:
        job = completed_job(
            client,
            client.post(
                "/v1/white-model-renders",
                files={
                    "source_image": ("white.png", white_model_bytes(), "image/png")
                },
            ),
        )

    assert job["status"] == "FAILED"
    assert job["errorCode"] == "KUYAO_IMAGE_REQUEST_FAILED"
    assert job["errorMessage"] == "mock provider unavailable"
    assert job["result"] is None


def test_local_preview_remains_available_without_ai_configuration(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "kuyao_api_key", "")
    monkeypatch.setattr(settings, "openai_api_key", "")
    monkeypatch.setattr(
        "app.processors.image.edit_floorplan_image",
        lambda *_args, **_kwargs: pytest.fail("local preview must not call the provider"),
    )

    with TestClient(app) as client:
        job = completed_job(
            client,
            client.post(
                "/v1/white-model-renders",
                files={
                    "source_image": ("white.png", white_model_bytes(), "image/png")
                },
                data={"generation_mode": "local_preview"},
            ),
        )

    assert job["status"] == "SUCCEEDED", job
    assert job["result"]["generationMode"] == "local_preview"
    assert job["result"]["provider"] == "local-demo-adapter"
    assert len(job["result"]["outputs"]) == 2


def test_white_model_rejects_more_than_three_style_references() -> None:
    source = white_model_bytes()
    files = [("source_image", ("white.png", source, "image/png"))]
    files.extend(
        ("style_references", (f"style-{index}.png", source, "image/png"))
        for index in range(4)
    )
    with TestClient(app) as client:
        response = client.post("/v1/white-model-renders", files=files)

    assert response.status_code == 422
    assert "最多上传 3 张" in response.json()["detail"]
