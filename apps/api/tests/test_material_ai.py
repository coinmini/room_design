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
from app.processors.image import MATERIAL_LOCAL_MODEL, run_material_replace


def _scene(width: int = 320, height: int = 240) -> np.ndarray:
    image = np.full((height, width, 3), (218, 220, 222), dtype=np.uint8)
    cv2.rectangle(image, (22, 20), (width - 22, height - 20), (55, 58, 62), 5)
    cv2.line(image, (22, height // 2), (width - 22, height // 2), (70, 73, 76), 4)
    cv2.rectangle(image, (125, 65), (205, 145), (130, 110, 90), -1)
    return image


def _masks(width: int = 320, height: int = 240) -> tuple[np.ndarray, np.ndarray]:
    wall = np.zeros((height, width), dtype=np.uint8)
    floor = np.zeros((height, width), dtype=np.uint8)
    cv2.rectangle(wall, (30, 28), (290, 105), 255, -1)
    cv2.rectangle(floor, (35, 145), (285, 220), 255, -1)
    return wall, floor


def _write(path: Path, image: np.ndarray) -> Path:
    assert cv2.imwrite(str(path), image)
    return path


def _payload(tmp_path: Path, *, wall_style: str, floor_style: str) -> tuple[dict, np.ndarray]:
    source = _scene()
    wall, floor = _masks()
    return (
        {
            "source_path": str(_write(tmp_path / "source.png", source)),
            "wall_mask_path": str(_write(tmp_path / "wall.png", wall)),
            "floor_mask_path": str(_write(tmp_path / "floor.png", floor)),
            "wall_style": wall_style,
            "floor_style": floor_style,
        },
        np.maximum(wall, floor),
    )


def _artifact(url: str) -> Path:
    return settings.artifact_dir / Path(url).name


def _configure_ai(monkeypatch: MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    monkeypatch.setattr(settings, "floorplan_final_image_provider", "auto")
    monkeypatch.setattr(settings, "kuyao_api_key", "test-only-key")
    monkeypatch.setattr(settings, "openai_api_key", "")
    monkeypatch.setattr(settings, "kuyao_image_model", "gpt-image-2")


def test_ai_material_edit_uses_mask_control_and_restores_outside_pixels(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    _configure_ai(monkeypatch, tmp_path)
    payload, combined_mask = _payload(
        tmp_path,
        wall_style="microcement_cream",
        floor_style="terrazzo_light",
    )
    calls: list[dict[str, Any]] = []

    def fake_edit(source_path: Path, **kwargs: Any) -> dict[str, Any]:
        authority = cv2.imread(str(source_path))
        assert authority is not None
        candidate = np.clip(
            authority.astype(np.float32) * 0.72 + np.array((32, 52, 68)) * 0.28,
            0,
            255,
        ).astype(np.uint8)
        output = _write(tmp_path / "provider-candidate.png", candidate)
        calls.append({"sourcePath": Path(source_path), **kwargs})
        return {
            "path": str(output),
            "url": f"/artifacts/{output.name}",
            "provider": "mock-kuyao",
            "model": kwargs["model"],
        }

    monkeypatch.setattr("app.processors.image.edit_floorplan_image", fake_edit)

    result = run_material_replace(payload)

    assert len(calls) == 1
    call = calls[0]
    assert call["size"] == "1536x1024"
    assert len(call["reference_paths"]) == 1
    assert Path(call["reference_paths"][0]).is_file()
    assert "BLUE pixels are wall-edit pixels" in call["prompt"]
    assert "cream microcement" in call["prompt"]
    assert "light terrazzo flooring" in call["prompt"]
    assert result["generationMode"] == "ai_edit"
    assert result["provider"] == "mock-kuyao"
    assert result["model"] == "gpt-image-2"
    assert result["requestedProvider"] == "kuyao-gpt-image-2"
    assert result["fallbackUsed"] is False
    assert result["fallbackReason"] is None
    assert result["outsideMaskPolicy"] == "source_pixels_preserved"
    assert result["providerOutputPostProcessed"] is True

    source = cv2.imread(payload["source_path"])
    output = cv2.imread(str(_artifact(result["outputUrl"])))
    assert source is not None and output is not None
    assert np.array_equal(output[combined_mask <= 32], source[combined_mask <= 32])
    assert np.any(output[combined_mask > 32] != source[combined_mask > 32])
    assert result["structureCheck"]["outsideMaskPixelsPreserved"] is True
    assert result["structureCheck"]["outsideMaskChangedPixelRatio"] == 0
    assert result["structureCheck"]["edgeRetention"] >= 0.65


def test_unconfigured_ai_uses_explicit_local_fallback_with_new_materials(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    monkeypatch.setattr(settings, "floorplan_final_image_provider", "auto")
    monkeypatch.setattr(settings, "kuyao_api_key", "")
    monkeypatch.setattr(settings, "openai_api_key", "")
    monkeypatch.setattr(
        "app.processors.image.edit_floorplan_image",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("unconfigured fallback must not call provider")
        ),
    )
    payload, combined_mask = _payload(
        tmp_path,
        wall_style="travertine_beige",
        floor_style="terrazzo_light",
    )

    result = run_material_replace(payload)

    assert result["generationMode"] == "ai_edit_fallback"
    assert result["provider"] == "local-material-fallback"
    assert result["model"] == MATERIAL_LOCAL_MODEL
    assert result["requestedProvider"] == "kuyao-gpt-image-2"
    assert result["fallbackUsed"] is True
    assert result["fallbackReason"] == "AI 材质编辑服务未配置或已关闭"
    assert "不是 AI 写实材质效果" in result["notice"]
    source = cv2.imread(payload["source_path"])
    output = cv2.imread(str(_artifact(result["outputUrl"])))
    assert source is not None and output is not None
    assert np.array_equal(output[combined_mask <= 32], source[combined_mask <= 32])
    assert np.any(output[combined_mask > 32] != source[combined_mask > 32])


def test_provider_failure_falls_back_without_exposing_provider_message(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    _configure_ai(monkeypatch, tmp_path)
    payload, _ = _payload(
        tmp_path,
        wall_style="microcement_cream",
        floor_style="oak_light",
    )
    leaked_secret = "sk-provider-secret-must-not-leak"

    def fail_edit(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise ProcessorError("KUYAO_IMAGE_TIMEOUT", f"timeout: {leaked_secret}")

    monkeypatch.setattr("app.processors.image.edit_floorplan_image", fail_edit)

    result = run_material_replace(payload)

    assert result["generationMode"] == "ai_edit_fallback"
    assert result["fallbackUsed"] is True
    assert result["fallbackReason"] == "AI 材质编辑请求超时"
    assert leaked_secret not in str(result)
    assert result["provider"] == "local-material-fallback"


@pytest.mark.parametrize("active_region", ["wall", "floor"])
def test_single_mask_leaves_the_other_region_and_all_unselected_pixels_unchanged(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
    active_region: str,
) -> None:
    monkeypatch.setattr(settings, "artifact_dir", tmp_path)
    monkeypatch.setattr(settings, "floorplan_final_image_provider", "auto")
    monkeypatch.setattr(settings, "kuyao_api_key", "")
    monkeypatch.setattr(settings, "openai_api_key", "")
    source = _scene()
    wall, floor = _masks()
    active_mask = wall if active_region == "wall" else floor
    payload = {
        "source_path": str(_write(tmp_path / "single-source.png", source)),
        "wall_mask_path": (
            str(_write(tmp_path / "single-wall.png", wall))
            if active_region == "wall"
            else None
        ),
        "floor_mask_path": (
            str(_write(tmp_path / "single-floor.png", floor))
            if active_region == "floor"
            else None
        ),
        "wall_style": "microcement_cream",
        "floor_style": "terrazzo_light",
    }

    result = run_material_replace(payload)

    output = cv2.imread(str(_artifact(result["outputUrl"])))
    assert output is not None
    assert np.array_equal(output[active_mask <= 32], source[active_mask <= 32])
    assert np.any(output[active_mask > 32] != source[active_mask > 32])
    assert result["structureCheck"]["selectedPixelRatio"] == pytest.approx(
        float(np.mean(active_mask > 32)),
        abs=0.0001,
    )


def test_material_endpoint_accepts_new_presets_and_rejects_unknown(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "floorplan_final_image_provider", "auto")
    monkeypatch.setattr(settings, "kuyao_api_key", "")
    monkeypatch.setattr(settings, "openai_api_key", "")
    success, encoded = cv2.imencode(".png", _scene())
    assert success
    image_bytes = encoded.tobytes()

    with TestClient(app) as client:
        response = client.post(
            "/v1/material-replacement-renders",
            files={"source_image": ("room.png", image_bytes, "image/png")},
            data={
                "wall_style": "travertine_beige",
                "floor_style": "terrazzo_light",
            },
        )
        assert response.status_code == 202, response.text
        job = client.get(f"/v1/jobs/{response.json()['id']}").json()
        assert job["status"] == "SUCCEEDED", job
        assert job["payload"]["wall_style"] == "travertine_beige"
        assert job["payload"]["floor_style"] == "terrazzo_light"
        assert job["result"]["generationMode"] == "ai_edit_fallback"
        asset = next(
            item
            for item in client.get(
                "/v1/assets?moduleKey=material_replacement&limit=100"
            ).json()
            if item["jobId"] == job["id"]
        )
        assert asset["generationMode"] == "ai_edit_fallback"
        assert asset["moduleName"] == "AI 多材质替换"
        assert asset["metadata"]["provider"] == "local-material-fallback"
        assert asset["metadata"]["requestedModel"] == "gpt-image-2"
        assert asset["metadata"]["fallbackUsed"] is True
        assert "本地蒙版材质预览" in asset["metadata"]["notice"]

        rejected = client.post(
            "/v1/material-replacement-renders",
            files={"source_image": ("room.png", image_bytes, "image/png")},
            data={"wall_style": "unknown_wall", "floor_style": "terrazzo_light"},
        )
        assert rejected.status_code == 422
