from __future__ import annotations

import base64
from dataclasses import replace
import json
import struct
from typing import Any

import cv2
import numpy as np
from fastapi.testclient import TestClient

from app import main
from app.comfyui import ComfyUIClient, OutputImage
from app.workflow import (
    OUTPUT_NODE_ID,
    add_ipadapter_style_reference,
    add_sdxl_refiner,
    build_sdxl_controlnet_img2img_workflow,
    build_sdxl_img2img_workflow,
)


PNG = (
    b"\x89PNG\r\n\x1a\n"
    + b"\x00\x00\x00\rIHDR"
    + struct.pack(">II", 1024, 768)
    + b"test-png-body"
)


def object_info(checkpoint: str) -> dict[str, Any]:
    info = {
        name: {"input": {"required": {}}}
        for name in (
            "CheckpointLoaderSimple",
            "LoadImage",
            "ImageScale",
            "VAEEncode",
            "CLIPTextEncode",
            "KSampler",
            "VAEDecode",
            "SaveImage",
        )
    }
    info["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"] = [
        [checkpoint]
    ]
    info["ControlNetLoader"] = {
        "input": {"required": {"control_net_name": [["depth.safetensors"]]}}
    }
    info["ControlNetApplyAdvanced"] = {"input": {"required": {}}}
    return info


class FakeComfyUI:
    def __init__(self, checkpoint: str) -> None:
        self.checkpoint = checkpoint
        self.workflow: dict[str, Any] | None = None

    def system_stats(self) -> dict[str, Any]:
        return {"devices": [{"name": "Mock GPU"}]}

    def object_info(self) -> dict[str, Any]:
        return object_info(self.checkpoint)

    def upload_image(self, png_bytes: bytes, filename: str) -> dict[str, Any]:
        assert png_bytes == PNG
        assert filename.endswith(".png")
        return {"name": filename, "subfolder": "", "type": "input"}

    def submit_prompt(self, workflow: dict[str, Any]) -> str:
        self.workflow = workflow
        return "prompt-123"

    def wait_for_output(self, prompt_id: str, output_node_id: str) -> OutputImage:
        assert prompt_id == "prompt-123"
        assert output_node_id == OUTPUT_NODE_ID
        return OutputImage("enhanced.png")

    def view_image(self, output: OutputImage) -> bytes:
        assert output.filename == "enhanced.png"
        return PNG


def test_workflow_is_core_sdxl_img2img_graph() -> None:
    workflow = build_sdxl_img2img_workflow(
        checkpoint="sdxl.safetensors",
        uploaded_image="base.png",
        prompt="warm apartment",
        negative_prompt="warped walls",
        seed=42,
        steps=24,
        cfg=6.0,
        strength=0.3,
        sampler_name="dpmpp_2m_sde",
        scheduler="karras",
        generation_width=1024,
        generation_height=768,
        output_width=1536,
        output_height=1152,
    )
    assert workflow["1"]["inputs"]["ckpt_name"] == "sdxl.safetensors"
    assert workflow["3"]["inputs"]["pixels"] == ["9", 0]
    assert workflow["6"]["inputs"]["denoise"] == 0.3
    assert workflow["6"]["inputs"]["latent_image"] == ["3", 0]
    assert workflow[OUTPUT_NODE_ID]["class_type"] == "SaveImage"
    assert workflow["10"]["inputs"]["width"] == 1536


def test_health_reports_checkpoint_and_controlnet(monkeypatch) -> None:
    checkpoint = "sdxl-test.safetensors"
    fake = FakeComfyUI(checkpoint)
    monkeypatch.setattr(
        main,
        "settings",
        replace(
            main.settings,
            checkpoint=checkpoint,
            controlnet_model="depth.safetensors",
        ),
    )
    monkeypatch.setattr(main, "get_client", lambda: fake)

    response = TestClient(main.app).get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["provider"] == "comfyui-sdxl-controlnet"
    assert body["mode"] == "sdxl-controlnet"
    assert body["capabilities"]["checkpointAvailable"] is True
    assert body["capabilities"]["controlNet"]["available"] is True


def test_controlnet_workflow_routes_conditioning_through_control() -> None:
    workflow = build_sdxl_controlnet_img2img_workflow(
        checkpoint="sdxl.safetensors",
        uploaded_image="base.png",
        uploaded_control="depth.png",
        controlnet_model="depth.safetensors",
        prompt="warm apartment",
        negative_prompt="changed walls",
        seed=17,
        steps=16,
        cfg=6.5,
        strength=0.32,
        control_strength=0.72,
        control_end_percent=0.86,
        sampler_name="dpmpp_2m_sde",
        scheduler="karras",
        generation_width=1024,
        generation_height=768,
        output_width=1536,
        output_height=1152,
    )
    assert workflow["13"]["class_type"] == "ControlNetLoader"
    assert workflow["14"]["inputs"]["image"] == ["12", 0]
    assert workflow["6"]["inputs"]["positive"] == ["14", 0]
    assert workflow["6"]["inputs"]["negative"] == ["14", 1]


def test_ipadapter_and_refiner_extend_controlled_workflow() -> None:
    workflow = build_sdxl_img2img_workflow(
        checkpoint="archviz.safetensors",
        uploaded_image="base.png",
        prompt="premium apartment",
        negative_prompt="clay render",
        seed=17,
        steps=28,
        cfg=5.5,
        strength=0.62,
        sampler_name="dpmpp_2m_sde",
        scheduler="karras",
        generation_width=1024,
        generation_height=768,
        output_width=1536,
        output_height=1152,
    )
    add_ipadapter_style_reference(
        workflow,
        uploaded_reference="reference.png",
        ipadapter_model="ipadapter.safetensors",
        clip_vision_model="clip-vit-h.safetensors",
        weight=0.6,
        style_boost=1.1,
        end_percent=0.85,
    )
    add_sdxl_refiner(
        workflow,
        checkpoint="refiner.safetensors",
        prompt="premium apartment",
        negative_prompt="clay render",
        seed=18,
        steps=20,
        cfg=5.0,
        denoise=0.2,
        sampler_name="dpmpp_2m_sde",
        scheduler="karras",
    )

    assert workflow["23"]["class_type"] == "IPAdapterPreciseStyleTransfer"
    assert workflow["23"]["inputs"]["clip_vision"] == ["22", 0]
    assert workflow["6"]["inputs"]["model"] == ["23", 0]
    assert workflow["33"]["inputs"]["latent_image"] == ["6", 0]
    assert workflow["33"]["inputs"]["denoise"] == 0.2
    assert workflow["7"]["inputs"]["samples"] == ["33", 0]
    assert workflow["7"]["inputs"]["vae"] == ["30", 2]


def test_enhance_runs_comfyui_workflow(monkeypatch) -> None:
    checkpoint = "sdxl-test.safetensors"
    fake = FakeComfyUI(checkpoint)
    monkeypatch.setattr(main, "settings", replace(main.settings, checkpoint=checkpoint))
    monkeypatch.setattr(main, "get_client", lambda: fake)
    request = {
        "version": "1.0",
        "prompt": "warm modern apartment",
        "negativePrompt": "changed walls",
        "strength": 0.28,
        "steps": 20,
        "cfg": 5.5,
        "seed": 1234,
        "images": {
            "base": "data:image/png;base64," + base64.b64encode(PNG).decode(),
            "edge": "data:image/png;base64,ignored-by-v1",
        },
    }

    response = TestClient(main.app).post("/v1/enhance", json=request)

    assert response.status_code == 200
    body = response.json()
    assert base64.b64decode(body["imageBase64"]) == PNG
    assert body["modelRevision"] == checkpoint
    assert body["provider"].startswith("comfyui-sdxl-img2img")
    assert body["seed"] == 1234
    assert body["generationWidth"] == 1024
    assert body["generationHeight"] == 768
    assert fake.workflow is not None
    assert fake.workflow["6"]["inputs"]["seed"] == 1234
    assert fake.workflow["6"]["inputs"]["steps"] == 20
    assert fake.workflow["6"]["inputs"]["cfg"] == 5.5


def test_enhance_uses_controlnet_when_configured(monkeypatch) -> None:
    checkpoint = "sdxl-test.safetensors"
    fake = FakeComfyUI(checkpoint)
    monkeypatch.setattr(
        main,
        "settings",
        replace(
            main.settings,
            checkpoint=checkpoint,
            controlnet_model="depth.safetensors",
            control_image="depth",
        ),
    )
    monkeypatch.setattr(main, "get_client", lambda: fake)
    data_url = "data:image/png;base64," + base64.b64encode(PNG).decode()

    response = TestClient(main.app).post(
        "/v1/enhance",
        json={
            "version": "1.0",
            "prompt": "warm modern apartment",
            "negativePrompt": "changed walls",
            "strength": 0.3,
            "seed": 17,
            "images": {"base": data_url, "depth": data_url},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "comfyui-sdxl-controlnet"
    assert body["mode"] == "sdxl-controlnet"
    assert body["controlImage"] == "depth"
    assert body["controlModel"] == "depth.safetensors"
    assert fake.workflow is not None
    assert fake.workflow["13"]["inputs"]["control_net_name"] == "depth.safetensors"


def test_enhance_rejects_non_png_data_url() -> None:
    response = TestClient(main.app).post(
        "/v1/enhance",
        json={
            "version": "1.0",
            "prompt": "room",
            "images": {"base": "data:image/jpeg;base64," + "a" * 40},
        },
    )
    assert response.status_code == 400
    assert "PNG data URL" in response.json()["detail"]


def test_style_reference_is_letterboxed_without_cropping() -> None:
    source = np.full((8, 12, 3), (40, 80, 120), dtype=np.uint8)
    encoded, png = cv2.imencode(".png", source)
    assert encoded is True

    squared = main._square_reference_png(png.tobytes(), "reference")

    image = cv2.imdecode(np.frombuffer(squared, dtype=np.uint8), cv2.IMREAD_COLOR)
    assert image.shape[:2] == (12, 12)
    assert tuple(image[6, 6]) == (40, 80, 120)
    assert tuple(image[0, 0]) == (255, 255, 255)


def test_client_calls_native_comfyui_endpoints(monkeypatch) -> None:
    calls: list[tuple[str, str, bytes | None]] = []
    responses = [
        json.dumps({"name": "base.png", "subfolder": "room-design"}).encode(),
        json.dumps({"prompt_id": "prompt-1"}).encode(),
        json.dumps(
            {
                "prompt-1": {
                    "outputs": {
                        OUTPUT_NODE_ID: {
                            "images": [
                                {
                                    "filename": "enhanced.png",
                                    "subfolder": "room-design",
                                    "type": "output",
                                }
                            ]
                        }
                    }
                }
            }
        ).encode(),
        PNG,
    ]

    class Response:
        def __init__(self, payload: bytes) -> None:
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *_args) -> None:
            return None

        def read(self, *_args) -> bytes:
            return self.payload

    def urlopen(request, timeout):
        assert timeout == 2.0
        calls.append((request.full_url, request.get_method(), request.data))
        return Response(responses.pop(0))

    monkeypatch.setattr("app.comfyui.urllib.request.urlopen", urlopen)
    client = ComfyUIClient(
        "http://127.0.0.1:8188",
        timeout_seconds=2.0,
        generation_timeout_seconds=2.0,
        poll_interval_seconds=0.01,
    )

    upload = client.upload_image(PNG, "base.png")
    prompt_id = client.submit_prompt({"1": {"class_type": "LoadImage"}})
    output = client.wait_for_output(prompt_id, OUTPUT_NODE_ID)
    result = client.view_image(output)

    assert upload["name"] == "base.png"
    assert result == PNG
    assert calls[0][0].endswith("/upload/image")
    assert calls[1][0].endswith("/prompt")
    assert calls[2][0].endswith("/history/prompt-1")
    assert "/view?" in calls[3][0]
    assert "filename=enhanced.png" in calls[3][0]
