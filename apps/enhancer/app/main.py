from __future__ import annotations

import base64
import binascii
import secrets
import struct
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException

from app.comfyui import (
    ComfyUIClient,
    ComfyUIError,
    ComfyUITimeout,
    uploaded_image_name,
)
from app.config import settings
from app.schemas import EnhanceRequest, EnhanceResponse
from app.workflow import (
    CONTROLNET_NODE_TYPES,
    IPADAPTER_NODE_TYPES,
    OUTPUT_NODE_ID,
    REQUIRED_NODE_TYPES,
    add_ipadapter_style_reference,
    add_sdxl_refiner,
    build_sdxl_controlnet_img2img_workflow,
    build_sdxl_img2img_workflow,
)


app = FastAPI(
    title="Room Design Local Enhancement Gateway",
    version="0.1.0",
    description="A local-only ComfyUI bridge for structure-anchored SDXL img2img.",
)


def get_client() -> ComfyUIClient:
    return ComfyUIClient(
        settings.comfyui_url,
        timeout_seconds=settings.timeout_seconds,
        generation_timeout_seconds=settings.generation_timeout_seconds,
        poll_interval_seconds=settings.poll_interval_seconds,
    )


def _node_choices(
    object_info: dict[str, Any],
    node_name: str,
    input_name: str,
) -> list[str]:
    try:
        choices = object_info[node_name]["input"]["required"][input_name][0]
    except (KeyError, IndexError, TypeError):
        return []
    if not isinstance(choices, list):
        return []
    return [str(choice) for choice in choices]


def _capabilities(object_info: dict[str, Any]) -> dict[str, Any]:
    node_types = set(object_info)
    checkpoints = _node_choices(object_info, "CheckpointLoaderSimple", "ckpt_name")
    control_models = _node_choices(object_info, "ControlNetLoader", "control_net_name")
    ipadapter_models = _node_choices(
        object_info,
        "IPAdapterModelLoader",
        "ipadapter_file",
    )
    clip_vision_models = _node_choices(object_info, "CLIPVisionLoader", "clip_name")
    apply_nodes = sorted(
        node_types.intersection({"ControlNetApply", "ControlNetApplyAdvanced"})
    )
    missing_nodes = sorted(REQUIRED_NODE_TYPES - node_types)
    configured_checkpoint = settings.checkpoint
    checkpoint_available = bool(
        configured_checkpoint and configured_checkpoint in checkpoints
    )
    configured_controlnet = settings.controlnet_model
    control_net_ready = bool(
        configured_controlnet
        and configured_controlnet in control_models
        and CONTROLNET_NODE_TYPES.issubset(node_types)
    )
    configured_refiner = settings.refiner_checkpoint
    refiner_ready = bool(
        configured_refiner and configured_refiner in checkpoints
    )
    configured_reference = settings.ipadapter_reference_image
    reference_available = bool(
        configured_reference
        and Path(configured_reference).expanduser().is_file()
    )
    ipadapter_ready = bool(
        settings.ipadapter_model
        and settings.ipadapter_model in ipadapter_models
        and settings.ipadapter_clip_vision
        and settings.ipadapter_clip_vision in clip_vision_models
        and reference_available
        and IPADAPTER_NODE_TYPES.issubset(node_types)
    )
    workflow_features = ["sdxl", "controlnet" if control_net_ready else "img2img"]
    if ipadapter_ready:
        workflow_features.append("ipadapter")
    if refiner_ready:
        workflow_features.append("refiner")
    return {
        "workflow": "-".join(workflow_features) + "-v2",
        "requiredNodesAvailable": not missing_nodes,
        "missingNodes": missing_nodes,
        "checkpointConfigured": bool(configured_checkpoint),
        "checkpointAvailable": checkpoint_available,
        "configuredCheckpoint": configured_checkpoint or None,
        "checkpoints": checkpoints,
        "controlNetReady": control_net_ready,
        "controlNet": {
            "available": control_net_ready,
            "configuredModel": configured_controlnet or None,
            "controlImage": settings.control_image,
            "models": control_models,
            "applyNodes": apply_nodes,
        },
        "refinerReady": refiner_ready,
        "refiner": {
            "available": refiner_ready,
            "configuredCheckpoint": configured_refiner or None,
            "steps": settings.refiner_steps,
            "denoise": settings.refiner_denoise,
        },
        "ipAdapterReady": ipadapter_ready,
        "ipAdapter": {
            "available": ipadapter_ready,
            "configuredModel": settings.ipadapter_model or None,
            "configuredClipVision": settings.ipadapter_clip_vision or None,
            "referenceImage": configured_reference or None,
            "referenceAvailable": reference_available,
            "models": ipadapter_models,
            "clipVisionModels": clip_vision_models,
            "missingNodes": sorted(IPADAPTER_NODE_TYPES - node_types),
            "weight": settings.ipadapter_weight,
        },
    }


@app.get("/health")
def health() -> dict[str, Any]:
    client = get_client()
    errors: list[str] = []
    system_stats: dict[str, Any] = {}
    object_info: dict[str, Any] = {}
    try:
        system_stats = client.system_stats()
    except (ComfyUIError, ValueError) as exc:
        errors.append(str(exc))
    try:
        object_info = client.object_info()
    except (ComfyUIError, ValueError) as exc:
        errors.append(str(exc))

    capabilities = _capabilities(object_info)
    if object_info:
        if not capabilities["requiredNodesAvailable"]:
            errors.append("ComfyUI is missing required core nodes")
        if not capabilities["checkpointConfigured"]:
            errors.append("COMFYUI_CHECKPOINT is not configured")
        elif not capabilities["checkpointAvailable"]:
            errors.append("Configured checkpoint is not installed in ComfyUI")
        configured_controlnet = capabilities["controlNet"]["configuredModel"]
        if configured_controlnet and not capabilities["controlNetReady"]:
            errors.append("Configured ControlNet model is not installed or nodes are missing")
        configured_refiner = capabilities["refiner"]["configuredCheckpoint"]
        if configured_refiner and not capabilities["refinerReady"]:
            errors.append("Configured SDXL Refiner checkpoint is not installed")
        configured_ipadapter = capabilities["ipAdapter"]["configuredModel"]
        if configured_ipadapter and not capabilities["ipAdapterReady"]:
            errors.append(
                "Configured IP-Adapter model, CLIP Vision, reference image or nodes are missing"
            )

    devices = system_stats.get("devices", [])
    control_net_ready = bool(capabilities["controlNetReady"])
    refiner_ready = bool(capabilities["refinerReady"])
    ipadapter_ready = bool(capabilities["ipAdapterReady"])
    reachable = bool(system_stats or object_info)
    active_features = ["sdxl", "controlnet" if control_net_ready else "img2img"]
    if ipadapter_ready:
        active_features.append("ipadapter")
    if refiner_ready:
        active_features.append("refiner")
    mode = "unavailable" if not reachable else "-".join(active_features)
    if not reachable:
        detail = "ComfyUI 未在 127.0.0.1:8188 启动，生成任务会由主 API 自动回退。"
    elif errors:
        detail = "; ".join(dict.fromkeys(errors))
    else:
        detail = "ComfyUI、ArchViz checkpoint 与已配置的增强组件均已就绪。"
    if reachable and not control_net_ready:
        detail += " 当前未安装可用 ControlNet，使用 SDXL img2img 降级模式。"
    return {
        "status": "ok" if not errors else "degraded",
        "service": "room-design-enhancer",
        "version": "0.1.0",
        "provider": (
            "comfyui-" + "-".join(active_features)
            if reachable
            else "comfyui-unavailable"
        ),
        "mode": mode,
        "detail": detail,
        "comfyui": {
            "url": settings.comfyui_url,
            "reachable": reachable,
            "devices": devices if isinstance(devices, list) else [],
        },
        "capabilities": capabilities,
        "errors": list(dict.fromkeys(errors)),
    }


def _decode_png_data_url(value: str, field_name: str = "images.base") -> bytes:
    marker = "data:image/png;base64,"
    if not value.startswith(marker):
        raise ValueError(f"{field_name} must be a PNG data URL")
    try:
        raw = base64.b64decode(value[len(marker) :], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{field_name} contains invalid base64") from exc
    return _validate_png_bytes(raw, field_name)


def _validate_png_bytes(raw: bytes, field_name: str) -> bytes:
    if len(raw) > settings.max_image_bytes:
        raise ValueError(f"{field_name} exceeds {settings.max_image_bytes} bytes")
    if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError(f"{field_name} is not a valid PNG payload")
    return raw


def _square_reference_png(raw: bytes, field_name: str) -> bytes:
    """Letterbox a style reference to square so CLIP Vision never center-crops it."""
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"{field_name} cannot be decoded as a PNG image")
    height, width = image.shape[:2]
    if width == height:
        return raw
    side = max(width, height)
    canvas = np.full((side, side, 3), 255, dtype=np.uint8)
    x = (side - width) // 2
    y = (side - height) // 2
    canvas[y : y + height, x : x + width] = image
    encoded, png = cv2.imencode(".png", canvas, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not encoded:
        raise ValueError(f"{field_name} cannot be encoded as a square PNG image")
    return _validate_png_bytes(png.tobytes(), field_name)


def _png_dimensions(raw: bytes) -> tuple[int, int]:
    if len(raw) < 24 or raw[12:16] != b"IHDR":
        raise ValueError("images.base does not contain a valid PNG IHDR")
    width, height = struct.unpack(">II", raw[16:24])
    if not (64 <= width <= 8192 and 64 <= height <= 8192):
        raise ValueError("images.base dimensions must be between 64 and 8192 pixels")
    return width, height


def _generation_dimensions(width: int, height: int) -> tuple[int, int]:
    scale = min(1.0, settings.max_generation_side / max(width, height))
    scaled_width = max(64, round(width * scale / 64) * 64)
    scaled_height = max(64, round(height * scale / 64) * 64)
    return scaled_width, scaled_height


def _resolve_checkpoint(object_info: dict[str, Any]) -> str:
    checkpoints = _node_choices(object_info, "CheckpointLoaderSimple", "ckpt_name")
    if not settings.checkpoint:
        raise ComfyUIError("COMFYUI_CHECKPOINT is not configured")
    if settings.checkpoint not in checkpoints:
        raise ComfyUIError(
            f"Configured checkpoint is unavailable in ComfyUI: {settings.checkpoint}"
        )
    missing_nodes = REQUIRED_NODE_TYPES - set(object_info)
    if missing_nodes:
        raise ComfyUIError(f"ComfyUI is missing nodes: {', '.join(sorted(missing_nodes))}")
    return settings.checkpoint


def _resolve_refiner(object_info: dict[str, Any]) -> str | None:
    if not settings.refiner_checkpoint:
        return None
    checkpoints = _node_choices(object_info, "CheckpointLoaderSimple", "ckpt_name")
    if settings.refiner_checkpoint not in checkpoints:
        raise ComfyUIError(
            f"Configured SDXL Refiner is unavailable: {settings.refiner_checkpoint}"
        )
    return settings.refiner_checkpoint


def _resolve_ipadapter(object_info: dict[str, Any]) -> tuple[str, str] | None:
    if not settings.ipadapter_model and not settings.ipadapter_clip_vision:
        return None
    missing_nodes = IPADAPTER_NODE_TYPES - set(object_info)
    if missing_nodes:
        raise ComfyUIError(
            f"ComfyUI is missing IP-Adapter nodes: {', '.join(sorted(missing_nodes))}"
        )
    models = _node_choices(object_info, "IPAdapterModelLoader", "ipadapter_file")
    if settings.ipadapter_model not in models:
        raise ComfyUIError(
            f"Configured IP-Adapter model is unavailable: {settings.ipadapter_model}"
        )
    clip_models = _node_choices(object_info, "CLIPVisionLoader", "clip_name")
    if settings.ipadapter_clip_vision not in clip_models:
        raise ComfyUIError(
            "Configured IP-Adapter CLIP Vision model is unavailable: "
            f"{settings.ipadapter_clip_vision}"
        )
    return settings.ipadapter_model, settings.ipadapter_clip_vision


def _resolve_style_reference(payload: EnhanceRequest) -> tuple[bytes, str]:
    if payload.images.reference:
        raw = _decode_png_data_url(payload.images.reference, "images.reference")
        return (
            _square_reference_png(raw, "images.reference"),
            "request:images.reference",
        )
    if not settings.ipadapter_reference_image:
        raise ComfyUIError(
            "IP-Adapter is configured but no style reference image was supplied"
        )
    path = Path(settings.ipadapter_reference_image).expanduser()
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ComfyUIError(f"Unable to read IP-Adapter reference image: {path}") from exc
    try:
        validated = _validate_png_bytes(raw, "COMFYUI_IPADAPTER_REFERENCE_IMAGE")
        return (
            _square_reference_png(validated, "COMFYUI_IPADAPTER_REFERENCE_IMAGE"),
            path.name,
        )
    except ValueError as exc:
        raise ComfyUIError(str(exc)) from exc


def _select_control_image(payload: EnhanceRequest) -> tuple[str, str] | None:
    configured = settings.control_image
    priority = (
        [configured]
        if configured in {"depth", "edge", "normal", "semantic"}
        else ["depth", "edge", "normal", "semantic"]
    )
    for name in priority:
        value = getattr(payload.images, name)
        if value:
            return name, value
    return None


def _resolve_controlnet(
    object_info: dict[str, Any],
    payload: EnhanceRequest,
) -> tuple[str, str, bytes] | None:
    if not settings.controlnet_model:
        return None
    models = _node_choices(object_info, "ControlNetLoader", "control_net_name")
    if settings.controlnet_model not in models:
        raise ComfyUIError(
            f"Configured ControlNet is unavailable: {settings.controlnet_model}"
        )
    missing_nodes = CONTROLNET_NODE_TYPES - set(object_info)
    if missing_nodes:
        raise ComfyUIError(
            f"ComfyUI is missing ControlNet nodes: {', '.join(sorted(missing_nodes))}"
        )
    selected = _select_control_image(payload)
    if selected is None:
        raise ComfyUIError("ControlNet is configured but no control image was supplied")
    name, data_url = selected
    return settings.controlnet_model, name, _decode_png_data_url(
        data_url,
        f"images.{name}",
    )


@app.post("/v1/enhance", response_model=EnhanceResponse)
def enhance(payload: EnhanceRequest) -> EnhanceResponse:
    try:
        base_png = _decode_png_data_url(payload.images.base)
        output_width, output_height = _png_dimensions(base_png)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    client = get_client()
    try:
        object_info = client.object_info()
        checkpoint = _resolve_checkpoint(object_info)
        refiner_checkpoint = _resolve_refiner(object_info)
        ipadapter = _resolve_ipadapter(object_info)
        control = _resolve_controlnet(object_info, payload)
        filename = f"room-design-{secrets.token_hex(8)}.png"
        upload = client.upload_image(base_png, filename)
        seed = payload.seed if payload.seed is not None else secrets.randbits(63)
        generation_width, generation_height = _generation_dimensions(
            output_width,
            output_height,
        )
        common_workflow = {
            "checkpoint": checkpoint,
            "uploaded_image": uploaded_image_name(upload),
            "prompt": payload.prompt,
            "negative_prompt": payload.negativePrompt,
            "seed": seed,
            "steps": payload.steps if payload.steps is not None else settings.steps,
            "cfg": payload.cfg if payload.cfg is not None else settings.cfg,
            "strength": payload.strength,
            "sampler_name": settings.sampler_name,
            "scheduler": settings.scheduler,
            "generation_width": generation_width,
            "generation_height": generation_height,
            "output_width": output_width,
            "output_height": output_height,
        }
        control_name: str | None = None
        control_model: str | None = None
        if control is not None:
            control_model, control_name, control_png = control
            control_upload = client.upload_image(
                control_png,
                f"room-design-{control_name}-{secrets.token_hex(8)}.png",
            )
            workflow = build_sdxl_controlnet_img2img_workflow(
                **common_workflow,
                uploaded_control=uploaded_image_name(control_upload),
                controlnet_model=control_model,
                control_strength=settings.control_strength,
                control_end_percent=settings.control_end_percent,
            )
        else:
            workflow = build_sdxl_img2img_workflow(**common_workflow)
        ipadapter_model: str | None = None
        style_reference: str | None = None
        if ipadapter is not None:
            ipadapter_model, clip_vision_model = ipadapter
            reference_png, style_reference = _resolve_style_reference(payload)
            reference_upload = client.upload_image(
                reference_png,
                f"room-design-reference-{secrets.token_hex(8)}.png",
            )
            workflow = add_ipadapter_style_reference(
                workflow,
                uploaded_reference=uploaded_image_name(reference_upload),
                ipadapter_model=ipadapter_model,
                clip_vision_model=clip_vision_model,
                weight=settings.ipadapter_weight,
                style_boost=settings.ipadapter_style_boost,
                end_percent=settings.ipadapter_end_percent,
            )
        if refiner_checkpoint is not None:
            workflow = add_sdxl_refiner(
                workflow,
                checkpoint=refiner_checkpoint,
                prompt=payload.prompt,
                negative_prompt=payload.negativePrompt,
                seed=(seed + 1) % (2**63),
                steps=settings.refiner_steps,
                cfg=settings.refiner_cfg,
                denoise=settings.refiner_denoise,
                sampler_name=settings.sampler_name,
                scheduler=settings.scheduler,
            )
        prompt_id = client.submit_prompt(workflow)
        output = client.wait_for_output(prompt_id, OUTPUT_NODE_ID)
        result_png = client.view_image(output)
        if len(result_png) > settings.max_image_bytes:
            raise ComfyUIError(
                f"ComfyUI output exceeds {settings.max_image_bytes} bytes"
            )
    except ComfyUITimeout as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except (ComfyUIError, ValueError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    active_features = ["sdxl", "controlnet" if control_model else "img2img"]
    if ipadapter_model:
        active_features.append("ipadapter")
    if refiner_checkpoint:
        active_features.append("refiner")
    mode = "-".join(active_features)
    return EnhanceResponse(
        imageBase64=base64.b64encode(result_png).decode("ascii"),
        provider=f"comfyui-{mode}",
        modelRevision=checkpoint,
        seed=seed,
        generationWidth=generation_width,
        generationHeight=generation_height,
        mode=mode,
        controlImage=control_name,
        controlModel=control_model,
        refinerCheckpoint=refiner_checkpoint,
        ipAdapterModel=ipadapter_model,
        styleReference=style_reference,
    )
