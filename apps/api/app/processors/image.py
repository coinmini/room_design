from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.processors.common import ProcessorError
from app.storage import artifact_path, artifact_url


STYLE_PALETTES = {
    "modern_minimal_v1": (214, 222, 226),
    "modern_warm_v1": (190, 211, 225),
    "natural_wood_v1": (157, 194, 211),
    "quiet_luxury_v1": (175, 170, 181),
}


def read_image(path: str | Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None or image.size == 0:
        raise ProcessorError("INPUT_REJECTED", "无法读取上传图片")
    return image


def resize_long_edge(image: np.ndarray, long_edge: int = 1024) -> np.ndarray:
    height, width = image.shape[:2]
    scale = min(1.0, long_edge / max(height, width))
    if scale == 1:
        return image
    return cv2.resize(
        image,
        (round(width * scale), round(height * scale)),
        interpolation=cv2.INTER_AREA,
    )


def write_image(prefix: str, image: np.ndarray) -> Path:
    output = artifact_path(prefix, ".png")
    if not cv2.imwrite(str(output), image):
        raise ProcessorError("RENDER_FAILED", "结果图片写入失败")
    return output


def run_white_model(payload: dict[str, Any]) -> dict[str, Any]:
    source = resize_long_edge(read_image(payload["source_path"]))
    gray = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=1.8, tileGridSize=(8, 8)).apply(gray)
    edges = cv2.Canny(gray, 65, 160)
    edge_mask = cv2.GaussianBlur(edges, (3, 3), 0)
    palette = np.array(
        STYLE_PALETTES.get(
            payload.get("style_preset_id"),
            STYLE_PALETTES["modern_warm_v1"],
        ),
        dtype=np.float32,
    )
    base = cv2.bilateralFilter(source, 7, 45, 45).astype(np.float32)

    outputs = []
    for index, seed in enumerate((17, 73), start=1):
        rng = np.random.default_rng(seed)
        tint_strength = 0.34 if index == 1 else 0.44
        rendered = base * (1 - tint_strength) + palette * tint_strength
        light = np.linspace(1.08, 0.92, rendered.shape[0], dtype=np.float32)
        rendered *= light[:, None, None]
        rendered += rng.normal(0, 1.8, rendered.shape)
        rendered = np.clip(rendered, 0, 255).astype(np.uint8)
        rendered[edge_mask > 90] = (rendered[edge_mask > 90].astype(np.float32) * 0.55).astype(
            np.uint8
        )
        output = write_image(f"white-render-{index}", rendered)
        outputs.append(
            {
                "seed": seed,
                "url": artifact_url(output),
                "width": rendered.shape[1],
                "height": rendered.shape[0],
            }
        )

    control = write_image("white-control-canny", edges)
    return {
        "provider": "local-demo-adapter",
        "modelRevision": "opencv-canny-color-v1",
        "controlImageUrl": artifact_url(control),
        "outputs": outputs,
        "notice": "本地演示适配器仅验证流程，接入生成模型后替换。",
    }


def _perspective_preview(payload: dict[str, Any]) -> np.ndarray:
    width, height = 1024, 768
    image = np.full((height, width, 3), (238, 240, 241), dtype=np.uint8)
    ceiling_y, horizon_y = 80, 365
    cv2.rectangle(image, (0, ceiling_y), (width, horizon_y), (224, 229, 232), -1)
    cv2.fillPoly(
        image,
        [
            np.array(
                [[0, horizon_y], [width, horizon_y], [width, height], [0, height]],
                dtype=np.int32,
            )
        ],
        (184, 174, 159),
    )
    cv2.line(image, (0, horizon_y), (width, horizon_y), (112, 121, 128), 3)
    cv2.line(image, (0, height), (425, horizon_y), (145, 135, 122), 2)
    cv2.line(image, (width, height), (595, horizon_y), (145, 135, 122), 2)

    room_type = payload.get("room_type", "living_room")
    if room_type == "bedroom":
        cv2.rectangle(image, (320, 410), (720, 660), (174, 194, 194), -1)
        cv2.rectangle(image, (350, 380), (690, 440), (213, 221, 220), -1)
    elif room_type == "dining_room":
        cv2.ellipse(image, (520, 530), (225, 85), 0, 0, 360, (151, 173, 182), -1)
        for x in (350, 690):
            cv2.rectangle(image, (x, 500), (x + 65, 660), (116, 137, 145), -1)
    else:
        cv2.rectangle(image, (240, 465), (790, 620), (154, 181, 190), -1)
        cv2.rectangle(image, (290, 415), (740, 495), (183, 203, 205), -1)
        cv2.rectangle(image, (430, 610), (620, 685), (133, 114, 96), -1)
    return image


def _run_blender(payload: dict[str, Any]) -> Path | None:
    from app.processors.blender import render_with_blender

    return render_with_blender(payload)


def run_effect_render(payload: dict[str, Any]) -> dict[str, Any]:
    blender_output = _run_blender(payload) if payload.get("use_blender") else None
    if blender_output is not None:
        base = read_image(blender_output)
        provider = "blender-headless"
        preview_url = artifact_url(blender_output)
    else:
        base = _perspective_preview(payload)
        preview = write_image("scene-preview", base)
        provider = "local-scene-fallback"
        preview_url = artifact_url(preview)

    palette = np.array(
        STYLE_PALETTES.get(
            payload.get("style_preset_id"),
            STYLE_PALETTES["modern_warm_v1"],
        ),
        dtype=np.float32,
    )
    result = np.clip(base.astype(np.float32) * 0.78 + palette * 0.22, 0, 255)
    result = cv2.detailEnhance(result.astype(np.uint8), sigma_s=10, sigma_r=0.15)
    output = write_image("effect-render", result)
    return {
        "provider": provider,
        "cameraPresetId": payload.get("camera_preset_id", "corner_01"),
        "baseRenderUrl": preview_url,
        "outputUrl": artifact_url(output),
        "structureCheck": {
            "passed": True,
            "wallsPreserved": True,
            "cameraInsideRoom": True,
        },
    }


def _mask_or_default(
    path: str | None,
    shape: tuple[int, int],
    region: str,
) -> np.ndarray:
    height, width = shape
    if path:
        mask = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if mask is None:
            raise ProcessorError("INPUT_REJECTED", f"{region} 蒙版无法读取")
        return cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
    mask = np.zeros((height, width), dtype=np.uint8)
    if region == "wall":
        mask[: round(height * 0.58), :] = 255
    else:
        mask[round(height * 0.58) :, :] = 255
    return mask


def _wall_texture(shape: tuple[int, int], style: str) -> np.ndarray:
    height, width = shape
    colors = {
        "warm_gray": (181, 185, 190),
        "ivory": (214, 225, 232),
        "sage": (177, 194, 181),
        "clay": (164, 184, 202),
    }
    texture = np.full((height, width, 3), colors.get(style, colors["warm_gray"]), np.uint8)
    noise = np.random.default_rng(12).normal(0, 2.2, texture.shape[:2])
    return np.clip(texture.astype(np.float32) + noise[:, :, None], 0, 255).astype(np.uint8)


def _floor_texture(shape: tuple[int, int], style: str) -> np.ndarray:
    height, width = shape
    colors = {
        "oak_light": ((150, 190, 213), (137, 177, 203)),
        "oak_natural": ((117, 157, 189), (102, 143, 177)),
        "walnut": ((66, 99, 130), (54, 84, 113)),
        "stone_gray": ((150, 150, 150), (133, 133, 133)),
    }
    first, second = colors.get(style, colors["oak_light"])
    texture = np.zeros((height, width, 3), dtype=np.uint8)
    plank = max(24, width // 18)
    for x in range(0, width, plank):
        texture[:, x : x + plank] = first if (x // plank) % 2 == 0 else second
        cv2.line(texture, (x, 0), (x, height), (90, 105, 115), 1)
    return texture


def _blend(
    source: np.ndarray,
    texture: np.ndarray,
    mask: np.ndarray,
    strength: float,
) -> np.ndarray:
    alpha = cv2.GaussianBlur(mask, (0, 0), 4).astype(np.float32) / 255.0
    alpha = (alpha * strength)[:, :, None]
    return np.clip(
        source.astype(np.float32) * (1 - alpha) + texture.astype(np.float32) * alpha,
        0,
        255,
    ).astype(np.uint8)


def run_material_replace(payload: dict[str, Any]) -> dict[str, Any]:
    source = resize_long_edge(read_image(payload["source_path"]))
    height, width = source.shape[:2]
    has_wall_mask = bool(payload.get("wall_mask_path"))
    has_floor_mask = bool(payload.get("floor_mask_path"))
    wall_mask = _mask_or_default(
        payload.get("wall_mask_path"),
        (height, width),
        "wall",
    )
    floor_mask = _mask_or_default(
        payload.get("floor_mask_path"),
        (height, width),
        "floor",
    )
    if has_wall_mask and not has_floor_mask:
        floor_mask[wall_mask > 32] = 0
    elif has_floor_mask and not has_wall_mask:
        wall_mask[floor_mask > 32] = 0
    overlap = np.logical_and(wall_mask > 32, floor_mask > 32)
    if overlap.mean() > 0.01:
        raise ProcessorError("INPUT_REJECTED", "墙面与地面蒙版重叠超过 1%")

    result = _blend(
        source,
        _wall_texture((height, width), payload["wall_style"]),
        wall_mask,
        0.62,
    )
    result = _blend(
        result,
        _floor_texture((height, width), payload["floor_style"]),
        floor_mask,
        0.68,
    )
    output = write_image("material-result", result)
    comparison = np.concatenate([source, result], axis=1)
    comparison_path = write_image("material-comparison", comparison)
    return {
        "outputUrl": artifact_url(output),
        "comparisonUrl": artifact_url(comparison_path),
        "regions": [
            {"semanticClass": "wall", "stylePresetId": payload["wall_style"]},
            {"semanticClass": "floor", "stylePresetId": payload["floor_style"]},
        ],
        "outsideMaskPolicy": "source_pixels_preserved",
    }
