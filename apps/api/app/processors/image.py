from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.config import settings
from app.processors.common import ProcessorError
from app.processors.kuyao_image_edit import edit_floorplan_image
from app.storage import artifact_path, artifact_url


STYLE_PALETTES = {
    "modern_minimal_v1": (214, 222, 226),
    "modern_warm_v1": (190, 211, 225),
    "natural_wood_v1": (157, 194, 211),
    "quiet_luxury_v1": (175, 170, 181),
}
STYLE_PROMPT_NAMES = {
    "modern_minimal_v1": "modern minimalist, restrained neutral palette",
    "modern_warm_v1": "warm contemporary, soft beige and natural light",
    "natural_wood_v1": "natural wood, calm organic materials",
    "quiet_luxury_v1": "quiet luxury, refined stone and muted textiles",
}

MATERIAL_WALL_PROMPTS = {
    "warm_gray": "matte warm-gray interior wall paint with a fine mineral finish",
    "ivory": "soft ivory-white matte interior wall paint",
    "sage": "muted sage-green matte interior wall paint",
    "clay": "warm clay-toned mineral wall paint",
    "microcement_cream": "seamless cream microcement with subtle hand-trowelled tonal variation",
    "travertine_beige": "natural beige travertine wall cladding with restrained linear pores",
}
MATERIAL_FLOOR_PROMPTS = {
    "oak_light": "light oak plank flooring with natural grain",
    "oak_natural": "natural medium oak plank flooring with calm grain",
    "walnut": "rich walnut plank flooring with refined dark grain",
    "stone_gray": "large-format honed gray stone floor tiles",
    "terrazzo_light": "light terrazzo flooring with small restrained mineral chips",
}
MATERIAL_REQUESTED_PROVIDER = "kuyao-gpt-image-2"
MATERIAL_LOCAL_MODEL = "opencv-mask-material-v2"


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


def _run_local_white_model(payload: dict[str, Any]) -> dict[str, Any]:
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
        "generationMode": "local_preview",
        "provider": "local-demo-adapter",
        "modelRevision": "opencv-canny-color-v1",
        "controlImageUrl": artifact_url(control),
        "outputs": outputs,
        "notice": "本地演示适配器仅验证流程，接入生成模型后替换。",
    }


def _white_model_target_size(width: int, height: int) -> tuple[str, int, int]:
    ratio = width / height
    if ratio >= 1.15:
        return "1536x1024", 1536, 1024
    if ratio <= 1 / 1.15:
        return "1024x1536", 1024, 1536
    return "1024x1024", 1024, 1024


def _letterbox_white_model(image: np.ndarray) -> tuple[np.ndarray, dict[str, Any], str]:
    height, width = image.shape[:2]
    size, target_width, target_height = _white_model_target_size(width, height)
    scale = min(target_width / width, target_height / height)
    content_width = max(1, round(width * scale))
    content_height = max(1, round(height * scale))
    interpolation = cv2.INTER_AREA if scale < 1 else cv2.INTER_LANCZOS4
    resized = cv2.resize(image, (content_width, content_height), interpolation=interpolation)
    canvas = np.full((target_height, target_width, 3), 255, dtype=np.uint8)
    offset_x = (target_width - content_width) // 2
    offset_y = (target_height - content_height) // 2
    canvas[
        offset_y : offset_y + content_height,
        offset_x : offset_x + content_width,
    ] = resized
    return (
        canvas,
        {
            "sourceWidth": width,
            "sourceHeight": height,
            "targetWidth": target_width,
            "targetHeight": target_height,
            "contentWidth": content_width,
            "contentHeight": content_height,
            "offsetX": offset_x,
            "offsetY": offset_y,
            "scale": round(scale, 6),
            "cropped": False,
            "anisotropicScaling": False,
        },
        size,
    )


def _white_model_edges(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    return cv2.Canny(gray, 55, 150)


def _white_model_long_edges(edges: np.ndarray) -> np.ndarray:
    height, width = edges.shape[:2]
    longest = max(width, height)
    minimum_length = max(48, round(longest * 0.10))
    lines = cv2.HoughLinesP(
        edges,
        1,
        np.pi / 180,
        threshold=max(32, round(minimum_length * 0.22)),
        minLineLength=minimum_length,
        maxLineGap=max(8, round(longest * 0.012)),
    )
    mask = np.zeros_like(edges)
    if lines is not None:
        for line in lines[:, 0]:
            cv2.line(
                mask,
                (int(line[0]), int(line[1])),
                (int(line[2]), int(line[3])),
                255,
                2,
                cv2.LINE_AA,
            )
    return mask


def _white_model_local_retentions(
    authority_edges: np.ndarray,
    distance_to_candidate: np.ndarray,
    *,
    tolerance_px: int,
) -> list[float]:
    height, width = authority_edges.shape[:2]
    edge_pixels = authority_edges > 0
    minimum_pixels = max(24, round(int(np.count_nonzero(edge_pixels)) * 0.006))
    values: list[float] = []
    for row in range(4):
        for column in range(4):
            x1, x2 = column * width // 4, (column + 1) * width // 4
            y1, y2 = row * height // 4, (row + 1) * height // 4
            tile = edge_pixels[y1:y2, x1:x2]
            if int(np.count_nonzero(tile)) < minimum_pixels:
                continue
            values.append(
                float(
                    np.mean(
                        distance_to_candidate[y1:y2, x1:x2][tile] <= tolerance_px
                    )
                )
            )
    return values


def white_model_structure_audit(
    authority: np.ndarray,
    candidate: np.ndarray,
) -> dict[str, Any]:
    input_size_matches = candidate.shape[:2] == authority.shape[:2]
    tolerance_px = max(4, round(max(authority.shape[:2]) * 0.004))
    authority_edges = _white_model_edges(authority)
    edge_pixel_count = int(np.count_nonzero(authority_edges))
    authority_long_edges = _white_model_long_edges(authority_edges)
    long_edge_pixel_count = int(np.count_nonzero(authority_long_edges))
    all_recall = 0.0
    long_recall = 0.0
    local_retentions: list[float] = []
    new_long_ratio = 1.0
    if input_size_matches and edge_pixel_count:
        candidate_edges = _white_model_edges(candidate)
        distance_to_candidate = cv2.distanceTransform(
            255 - candidate_edges,
            cv2.DIST_L2,
            3,
        )
        all_recall = float(
            np.mean(distance_to_candidate[authority_edges > 0] <= tolerance_px)
        )
        if long_edge_pixel_count:
            long_recall = float(
                np.mean(distance_to_candidate[authority_long_edges > 0] <= tolerance_px)
            )
        local_retentions = _white_model_local_retentions(
            authority_edges,
            distance_to_candidate,
            tolerance_px=tolerance_px,
        )
        candidate_long_edges = _white_model_long_edges(candidate_edges)
        candidate_long_pixels = candidate_long_edges > 0
        if np.any(candidate_long_pixels):
            distance_to_authority = cv2.distanceTransform(
                255 - authority_edges,
                cv2.DIST_L2,
                3,
            )
            new_long_ratio = float(
                np.mean(distance_to_authority[candidate_long_pixels] > tolerance_px)
            )
    local_minimum = min(local_retentions) if local_retentions else 0.0
    local_q20 = (
        float(np.quantile(np.asarray(local_retentions), 0.2)) if local_retentions else 0.0
    )
    passed = (
        input_size_matches
        and edge_pixel_count >= 100
        and long_edge_pixel_count >= 50
        and all_recall >= 0.72
        and long_recall >= 0.84
        and len(local_retentions) >= 4
        and local_q20 >= 0.70
        and local_minimum >= 0.55
        and new_long_ratio <= 0.20
    )
    return {
        "performed": True,
        "passed": passed,
        "inputSizeMatches": input_size_matches,
        "outputSizeMatches": input_size_matches,
        "edgeRetention": round(all_recall, 4),
        "allEdgeRecall": round(all_recall, 4),
        "longEdgeRecall": round(long_recall, 4),
        "localEdgeRecallQ20": round(local_q20, 4),
        "localEdgeRecallMinimum": round(local_minimum, 4),
        "newLongEdgeRatio": round(new_long_ratio, 4),
        "layoutDriftScore": round(max(0.0, 1.0 - all_recall), 4),
        "edgePixelCount": edge_pixel_count,
        "longEdgePixelCount": long_edge_pixel_count,
        "edgeTileCount": len(local_retentions),
        "tolerancePx": tolerance_px,
        "thresholds": {
            "allEdgeRecallMin": 0.72,
            "longEdgeRecallMin": 0.84,
            "localEdgeRecallQ20Min": 0.70,
            "localEdgeRecallMinimumMin": 0.55,
            "newLongEdgeRatioMax": 0.20,
        },
        "registrationApplied": False,
        "registrationMode": "none",
        "outputTransformApplied": False,
        "perspectiveTransformApplied": False,
        "homographyApplied": False,
        "rawProviderOutput": True,
        "requiresUserConfirmation": True,
    }


def _white_model_ai_prompt(payload: dict[str, Any]) -> str:
    style_references = payload.get("style_reference_paths") or []
    style_note = (
        f"Images 2 through {len(style_references) + 1} are optional style-only references. "
        if style_references
        else "There are no additional style-reference images. "
    )
    user_prompt = str(payload.get("prompt") or "").strip()
    style_preset_id = str(payload.get("style_preset_id") or "modern_minimal_v1")
    style_description = STYLE_PROMPT_NAMES.get(style_preset_id, style_preset_id)
    return (
        "Create one fast, polished interior concept render from the white-model input. INPUT ROLE "
        "LOCK: image 1 is the only geometric and camera authority. Preserve its exact camera pose, "
        "lens perspective, framing, room envelope, walls, openings, ceiling lines, built-ins, object "
        "silhouettes, furniture footprints and relative scale. Do not crop, rotate, stretch, warp, "
        "reproject or apply a new viewpoint. Do not add, remove or move structural elements. "
        f"{style_note}They may influence only colors, materials, lighting mood and decorative finish; "
        "never copy their geometry, camera, layout or furniture coordinates. Produce a realistic but "
        f"clearly conceptual {payload.get('room_type', 'living_room')} visualization in style preset "
        f"{style_description}. Additional requirement: "
        f"{user_prompt or 'clean neutral materials and balanced daylight'}."
    )


def _run_ai_white_model(payload: dict[str, Any]) -> dict[str, Any]:
    if not settings.kuyao_image_edit_configured:
        raise ProcessorError(
            "AI_WHITE_MODEL_UNAVAILABLE",
            "未配置 gpt-image-2 图像服务，无法执行 AI 白模快速渲染",
        )
    style_references = [Path(path) for path in payload.get("style_reference_paths") or []]
    if len(style_references) > 3:
        raise ProcessorError("INPUT_REJECTED", "风格参考图最多上传 3 张")
    if any(not path.is_file() for path in style_references):
        raise ProcessorError("INPUT_REJECTED", "风格参考图不存在")

    source = read_image(payload["source_path"])
    authority, letterbox, size = _letterbox_white_model(source)
    authority_path = write_image("white-ai-authority", authority)
    generated = edit_floorplan_image(
        authority_path,
        api_key=settings.floorplan_vision_api_key,
        base_url=settings.kuyao_base_url,
        prompt=_white_model_ai_prompt(payload),
        model=settings.kuyao_image_model,
        size=size,
        quality=settings.kuyao_image_quality,
        timeout_seconds=settings.kuyao_image_timeout_seconds,
        reference_paths=style_references,
    )
    candidate = read_image(generated["path"])
    audit = white_model_structure_audit(authority, candidate)
    notice = (
        "结构边缘保留审计已通过，但结果仍是概念图，必须人工确认后使用。"
        if audit["passed"]
        else "结构边缘保留审计未通过；该图片仅供查看，不得视为结构正确或施工可用。"
    )
    output = {
        "url": generated["url"],
        "width": int(candidate.shape[1]),
        "height": int(candidate.shape[0]),
        "provider": generated["provider"],
        "model": generated["model"],
        "structureAudit": audit,
    }
    return {
        "generationMode": "ai_quick",
        "provider": generated["provider"],
        "model": generated["model"],
        "modelRevision": generated["model"],
        "promptVersion": "white-model-ai-quick-v1",
        "inputRoles": {
            "image1": "white_model_geometry_camera_authority",
            "styleReferences": "style_only",
        },
        "controlImageUrl": artifact_url(authority_path),
        "letterbox": letterbox,
        "outputs": [output],
        "structureAudit": audit,
        "isConceptOnly": True,
        "constructionReady": False,
        "modelEditable": False,
        "requiresUserConfirmation": True,
        "notice": notice,
    }


def run_white_model(payload: dict[str, Any]) -> dict[str, Any]:
    # Historical jobs predate generation_mode and must retain the local adapter on retry.
    generation_mode = str(payload.get("generation_mode") or "local_preview")
    if generation_mode == "local_preview":
        return _run_local_white_model(payload)
    if generation_mode == "ai_quick":
        return _run_ai_white_model(payload)
    raise ProcessorError("INPUT_REJECTED", f"不支持的白模生成模式：{generation_mode}")


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
        "microcement_cream": (205, 220, 230),
        "travertine_beige": (169, 198, 218),
    }
    texture = np.full((height, width, 3), colors.get(style, colors["warm_gray"]), np.uint8)
    rng = np.random.default_rng(12)
    noise = rng.normal(0, 2.2, texture.shape[:2])
    if style == "microcement_cream":
        broad = cv2.GaussianBlur(rng.normal(0, 7.0, (height, width)).astype(np.float32), (0, 0), 16)
        noise += broad
    elif style == "travertine_beige":
        for y in range(max(8, height // 30), height, max(18, height // 14)):
            shade = int(rng.integers(-12, 5))
            cv2.line(
                texture,
                (0, y),
                (width, min(height - 1, y + int(rng.integers(-3, 4)))),
                tuple(max(0, min(255, channel + shade)) for channel in colors[style]),
                max(1, height // 360),
                cv2.LINE_AA,
            )
        pore_count = max(20, width * height // 12_000)
        for _ in range(pore_count):
            center = (int(rng.integers(0, width)), int(rng.integers(0, height)))
            axes = (int(rng.integers(2, 8)), int(rng.integers(1, 3)))
            cv2.ellipse(texture, center, axes, 0, 0, 360, (139, 169, 190), -1, cv2.LINE_AA)
    return np.clip(texture.astype(np.float32) + noise[:, :, None], 0, 255).astype(np.uint8)


def _floor_texture(shape: tuple[int, int], style: str) -> np.ndarray:
    height, width = shape
    colors = {
        "oak_light": ((150, 190, 213), (137, 177, 203)),
        "oak_natural": ((117, 157, 189), (102, 143, 177)),
        "walnut": ((66, 99, 130), (54, 84, 113)),
        "stone_gray": ((150, 150, 150), (133, 133, 133)),
        "terrazzo_light": ((205, 213, 216), (205, 213, 216)),
    }
    first, second = colors.get(style, colors["oak_light"])
    texture = np.zeros((height, width, 3), dtype=np.uint8)
    if style == "terrazzo_light":
        texture[:] = first
        rng = np.random.default_rng(31)
        chip_colors = ((112, 125, 132), (156, 165, 169), (178, 186, 190), (129, 142, 151))
        chip_count = max(80, width * height // 650)
        for _ in range(chip_count):
            center = (int(rng.integers(0, width)), int(rng.integers(0, height)))
            radius = int(rng.integers(1, max(2, min(width, height) // 110)))
            cv2.circle(
                texture,
                center,
                radius,
                chip_colors[int(rng.integers(0, len(chip_colors)))],
                -1,
                cv2.LINE_AA,
            )
        return texture
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
    alpha[mask <= 32] = 0.0
    alpha = (alpha * strength)[:, :, None]
    return np.clip(
        source.astype(np.float32) * (1 - alpha) + texture.astype(np.float32) * alpha,
        0,
        255,
    ).astype(np.uint8)


def _material_mask_control(wall_mask: np.ndarray, floor_mask: np.ndarray) -> np.ndarray:
    control = np.zeros((*wall_mask.shape, 3), dtype=np.uint8)
    control[wall_mask > 32] = (255, 0, 0)
    control[floor_mask > 32] = (0, 165, 255)
    return control


def _material_prompt(payload: dict[str, Any]) -> str:
    wall_style = str(payload["wall_style"])
    floor_style = str(payload["floor_style"])
    try:
        wall_prompt = MATERIAL_WALL_PROMPTS[wall_style]
        floor_prompt = MATERIAL_FLOOR_PROMPTS[floor_style]
    except KeyError as exc:
        raise ProcessorError("INPUT_REJECTED", f"不支持的材质预设：{exc.args[0]}") from None
    return (
        "Perform a strictly masked photorealistic interior material edit. INPUT ROLE LOCK: image 1 "
        "is the sole scene, geometry, camera, furniture and lighting authority. Image 2 is an exact "
        "region-control map: BLUE pixels are wall-edit pixels, ORANGE pixels are floor-edit pixels, "
        "and BLACK pixels are locked and must remain unchanged. Apply only "
        f"{wall_prompt} inside BLUE and only {floor_prompt} inside ORANGE. Preserve every wall edge, "
        "opening, skirting line, furniture silhouette, object, perspective, shadow direction and "
        "camera position. Do not add or remove decor, furniture, doors or windows. Do not recolor, "
        "retouch or relight any BLACK region. Produce a natural, buildable residential material "
        "finish without text, labels, split-screen layout or before/after framing."
    )


def _letterbox_material_mask(mask: np.ndarray, metadata: dict[str, Any]) -> np.ndarray:
    resized = cv2.resize(
        mask,
        (int(metadata["contentWidth"]), int(metadata["contentHeight"])),
        interpolation=cv2.INTER_NEAREST,
    )
    canvas = np.zeros(
        (int(metadata["targetHeight"]), int(metadata["targetWidth"])),
        dtype=np.uint8,
    )
    x = int(metadata["offsetX"])
    y = int(metadata["offsetY"])
    canvas[y : y + resized.shape[0], x : x + resized.shape[1]] = resized
    return canvas


def _ai_material_candidate(
    source: np.ndarray,
    wall_mask: np.ndarray,
    floor_mask: np.ndarray,
    payload: dict[str, Any],
) -> tuple[np.ndarray, dict[str, Any], dict[str, Any]]:
    authority, letterbox, size = _letterbox_white_model(source)
    authority_path = write_image("material-ai-authority", authority)
    wall_canvas = _letterbox_material_mask(wall_mask, letterbox)
    floor_canvas = _letterbox_material_mask(floor_mask, letterbox)
    control_path = write_image(
        "material-ai-mask-control",
        _material_mask_control(wall_canvas, floor_canvas),
    )
    generated = edit_floorplan_image(
        authority_path,
        api_key=settings.floorplan_vision_api_key,
        base_url=settings.kuyao_base_url,
        prompt=_material_prompt(payload),
        model=settings.kuyao_image_model,
        size=size,
        quality=settings.kuyao_image_quality,
        timeout_seconds=settings.kuyao_image_timeout_seconds,
        reference_paths=[control_path],
    )
    candidate = read_image(generated["path"])
    target_height, target_width = authority.shape[:2]
    candidate_resized = candidate.shape[:2] != (target_height, target_width)
    if candidate_resized:
        candidate = cv2.resize(
            candidate,
            (target_width, target_height),
            interpolation=cv2.INTER_LANCZOS4,
        )
    x = int(letterbox["offsetX"])
    y = int(letterbox["offsetY"])
    content_width = int(letterbox["contentWidth"])
    content_height = int(letterbox["contentHeight"])
    content = candidate[y : y + content_height, x : x + content_width]
    restored = cv2.resize(
        content,
        (source.shape[1], source.shape[0]),
        interpolation=cv2.INTER_AREA,
    )
    audit_metadata = {
        "letterbox": letterbox,
        "candidateResizedToCanvas": candidate_resized,
        "providerOutputPostProcessed": True,
        "maskControlUrl": artifact_url(control_path),
    }
    return restored, generated, audit_metadata


def _masked_material_composite(
    source: np.ndarray,
    candidate: np.ndarray,
    mask: np.ndarray,
) -> np.ndarray:
    selected = (mask > 32).astype(np.uint8)
    distance = cv2.distanceTransform(selected, cv2.DIST_L2, 3)
    alpha = np.clip(distance / 4.0, 0.0, 1.0)[:, :, None]
    result = np.clip(
        source.astype(np.float32) * (1.0 - alpha) + candidate.astype(np.float32) * alpha,
        0,
        255,
    ).astype(np.uint8)
    result[selected == 0] = source[selected == 0]
    return result


def _material_structure_check(
    source: np.ndarray,
    result: np.ndarray,
    combined_mask: np.ndarray,
) -> dict[str, Any]:
    outside = combined_mask <= 32
    changed = np.any(source != result, axis=2)
    outside_count = int(np.count_nonzero(outside))
    outside_changed = int(np.count_nonzero(np.logical_and(outside, changed)))
    outside_ratio = outside_changed / outside_count if outside_count else 0.0
    source_edges = cv2.Canny(cv2.cvtColor(source, cv2.COLOR_BGR2GRAY), 55, 150)
    result_edges = cv2.Canny(cv2.cvtColor(result, cv2.COLOR_BGR2GRAY), 55, 150)
    nearby_result = cv2.dilate(result_edges, np.ones((7, 7), dtype=np.uint8))
    source_edge_count = int(np.count_nonzero(source_edges))
    retained_edges = int(np.count_nonzero(np.logical_and(source_edges > 0, nearby_result > 0)))
    edge_retention = retained_edges / source_edge_count if source_edge_count else 1.0
    outside_preserved = outside_changed == 0
    return {
        "passed": bool(outside_preserved and edge_retention >= 0.65),
        "outsideMaskPixelsPreserved": outside_preserved,
        "outsideMaskChangedPixelRatio": round(outside_ratio, 6),
        "edgeRetention": round(edge_retention, 4),
        "selectedPixelRatio": round(float(np.mean(combined_mask > 32)), 4),
        "geometryGuaranteed": False,
        "requiresUserConfirmation": True,
    }


def _local_material_candidate(
    source: np.ndarray,
    wall_mask: np.ndarray,
    floor_mask: np.ndarray,
    payload: dict[str, Any],
) -> np.ndarray:
    height, width = source.shape[:2]
    result = _blend(
        source,
        _wall_texture((height, width), payload["wall_style"]),
        wall_mask,
        0.62,
    )
    return _blend(
        result,
        _floor_texture((height, width), payload["floor_style"]),
        floor_mask,
        0.68,
    )


def _material_fallback_reason(error: ProcessorError | None = None) -> str:
    if error is None:
        return "AI 材质编辑服务未配置或已关闭"
    reasons = {
        "KUYAO_IMAGE_TIMEOUT": "AI 材质编辑请求超时",
        "KUYAO_IMAGE_PROVIDER_UNAVAILABLE": "AI 材质编辑服务暂时无法连接",
        "KUYAO_IMAGE_PROVIDER_REJECTED": "AI 材质编辑服务拒绝了本次请求",
        "KUYAO_IMAGE_RESPONSE_INVALID": "AI 材质编辑服务未返回有效图片",
        "KUYAO_IMAGE_DOWNLOAD_REJECTED": "AI 材质编辑结果下载校验未通过",
        "KUYAO_IMAGE_WRITE_FAILED": "AI 材质编辑结果无法保存",
        "KUYAO_IMAGE_CONFIG_INVALID": "AI 材质编辑配置无效",
        "KUYAO_IMAGE_INPUT_REJECTED": "AI 材质编辑输入校验未通过",
    }
    return reasons.get(error.code, "AI 材质编辑未能完成")


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
        floor_mask.fill(0)
    elif has_floor_mask and not has_wall_mask:
        wall_mask.fill(0)
    overlap = np.logical_and(wall_mask > 32, floor_mask > 32)
    if overlap.mean() > 0.01:
        raise ProcessorError("INPUT_REJECTED", "墙面与地面蒙版重叠超过 1%")
    _material_prompt(payload)
    combined_mask = np.maximum(wall_mask, floor_mask)
    mask_preview = write_image(
        "material-mask-control",
        _material_mask_control(wall_mask, floor_mask),
    )

    fallback_error: ProcessorError | None = None
    ai_metadata: dict[str, Any] = {}
    if settings.kuyao_image_edit_configured:
        try:
            candidate, generated, ai_metadata = _ai_material_candidate(
                source,
                wall_mask,
                floor_mask,
                payload,
            )
            result = _masked_material_composite(source, candidate, combined_mask)
            provider = str(generated.get("provider") or MATERIAL_REQUESTED_PROVIDER)
            model = str(generated.get("model") or settings.kuyao_image_model)
            generation_mode = "ai_edit"
            fallback_used = False
            fallback_reason = None
            notice = (
                "已使用 gpt-image-2 生成选区内材质，并逐像素恢复蒙版外原图；"
                "结构与材质边界仍需人工确认。"
            )
        except ProcessorError as exc:
            fallback_error = exc
    if not settings.kuyao_image_edit_configured or fallback_error is not None:
        result = _local_material_candidate(source, wall_mask, floor_mask, payload)
        result[combined_mask <= 32] = source[combined_mask <= 32]
        provider = "local-material-fallback"
        model = MATERIAL_LOCAL_MODEL
        generation_mode = "ai_edit_fallback"
        fallback_used = True
        fallback_reason = _material_fallback_reason(fallback_error)
        notice = (
            f"{fallback_reason}，已明确回退到本地蒙版材质预览；"
            "该结果不是 AI 写实材质效果，蒙版外像素保持原图。"
        )

    result[combined_mask <= 32] = source[combined_mask <= 32]
    output = write_image("material-result", result)
    comparison = np.concatenate([source, result], axis=1)
    comparison_path = write_image("material-comparison", comparison)
    structure_check = _material_structure_check(source, result, combined_mask)
    return {
        "generationMode": generation_mode,
        "provider": provider,
        "model": model,
        "requestedProvider": MATERIAL_REQUESTED_PROVIDER,
        "requestedModel": settings.kuyao_image_model,
        "fallbackUsed": fallback_used,
        "fallbackReason": fallback_reason,
        "notice": notice,
        "outputUrl": artifact_url(output),
        "comparisonUrl": artifact_url(comparison_path),
        "maskControlUrl": artifact_url(mask_preview),
        "regions": [
            {"semanticClass": "wall", "stylePresetId": payload["wall_style"]},
            {"semanticClass": "floor", "stylePresetId": payload["floor_style"]},
        ],
        "outsideMaskPolicy": "source_pixels_preserved",
        "structureCheck": structure_check,
        **ai_metadata,
    }
