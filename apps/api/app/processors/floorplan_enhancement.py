from __future__ import annotations

import base64
import json
import math
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.config import settings
from app.processors.common import ProcessorError
from app.processors.image import read_image, write_image
from app.processors.kuyao_image_edit import edit_floorplan_image
from app.storage import artifact_url


STYLE_PROMPTS = {
    "modern_minimal_v1": (
        "modern minimalist apartment, warm white plaster walls, pale oak plank flooring, "
        "tailored ivory upholstery, slim black accents and uncluttered built-in storage"
    ),
    "modern_warm_v1": (
        "warm modern apartment, natural oak plank flooring, ivory linen upholstery, "
        "realistic residential furniture, oak cabinetry and softly layered neutral textiles"
    ),
    "natural_wood_v1": (
        "natural Scandinavian apartment, warm timber cabinetry, woven textiles, indoor "
        "plants, pale rugs and light contemporary furniture"
    ),
    "quiet_luxury_v1": (
        "quiet luxury apartment, warm stone, walnut joinery, textured neutral fabrics, "
        "refined furniture and restrained bronze details"
    ),
}


@dataclass
class EnhancementResult:
    image: np.ndarray
    provider: str
    model_revision: str
    notice: str
    requested: bool
    seed: int
    mode: str
    control_image: str | None = None
    control_model: str | None = None
    seed_mode: str = "audit-only"


def _health_endpoint() -> str:
    if settings.floorplan_ai_health_endpoint:
        return settings.floorplan_ai_health_endpoint
    parsed = urllib.parse.urlsplit(settings.floorplan_ai_endpoint)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/health", "", ""))


def enhancement_capability() -> dict[str, Any]:
    """Return a small, secret-free status object for the web health check.

    The enhancement endpoint is operator-controlled. A failed probe must never make
    the room-design API unhealthy because the registered local fallback still works.
    """
    if settings.kuyao_image_edit_configured:
        return {
            "configured": True,
            "reachable": None,
            "provider": "kuyao-gpt-image-2",
            "mode": "image-edit",
            "controlNetReady": None,
            "detail": (
                "Kuyao gpt-image-2 已配置；最终渲染会优先执行结构保持的图像编辑，"
                "失败时回退到本地增强。"
            ),
        }

    configured = bool(settings.floorplan_ai_endpoint)
    if not configured:
        return {
            "configured": False,
            "reachable": None,
            "provider": "local-structure-preserving-v2",
            "mode": "registered-local-fallback",
            "controlNetReady": None,
            "detail": "未配置生成式增强服务，将使用像素配准的本地增强。",
        }

    try:
        request = urllib.request.Request(
            _health_endpoint(),
            method="GET",
            headers=(
                {"Authorization": f"Bearer {settings.floorplan_ai_token}"}
                if settings.floorplan_ai_token
                else {}
            ),
        )
        with urllib.request.urlopen(  # noqa: S310 - operator-configured endpoint
            request,
            timeout=settings.floorplan_ai_probe_timeout_seconds,
        ) as response:
            raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("增强服务健康响应超过 1 MB")
        payload = json.loads(raw.decode("utf-8"))
        capabilities = payload.get("capabilities") or {}
        status = str(payload.get("status", "ok"))
        service_state = payload.get("comfyui") or {}
        reported_reachable = service_state.get("reachable")
        reachable = (
            bool(reported_reachable)
            if isinstance(reported_reachable, bool)
            else status not in {"offline", "unavailable", "error"}
        )
        control_net = capabilities.get("controlNetReady")
        if control_net is None and isinstance(capabilities.get("controlNet"), dict):
            control_net = capabilities["controlNet"].get("available")
        return {
            "configured": True,
            "reachable": reachable,
            "provider": str(payload.get("provider", "configured-http-provider")),
            "mode": str(payload.get("mode", "controlled-generation")),
            "controlNetReady": control_net,
            "detail": str(
                payload.get("detail")
                or payload.get("message")
                or ("增强服务已连接。" if reachable else "增强服务暂不可用。")
            ),
        }
    except (
        OSError,
        TimeoutError,
        ValueError,
        json.JSONDecodeError,
        urllib.error.URLError,
    ) as exc:
        return {
            "configured": True,
            "reachable": False,
            "provider": "configured-http-provider",
            "mode": "registered-local-fallback",
            "controlNetReady": None,
            "detail": f"增强服务不可达，任务会自动回退：{type(exc).__name__}",
        }


def _png_data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _decode_provider_image(payload: dict[str, Any]) -> np.ndarray:
    encoded = payload.get("imageBase64") or payload.get("image_base64")
    if not encoded:
        raise ValueError("增强服务响应缺少 imageBase64")
    if "," in encoded:
        encoded = encoded.split(",", 1)[1]
    raw = np.frombuffer(base64.b64decode(encoded), dtype=np.uint8)
    image = cv2.imdecode(raw, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("增强服务返回的图片无法解码")
    return image


def _enhancement_prompt(payload: dict[str, Any]) -> str:
    style_prompt = STYLE_PROMPTS.get(
        payload.get("style_preset_id"),
        STYLE_PROMPTS["modern_warm_v1"],
    )
    strength = min(0.9, max(0.2, float(payload.get("enhancement_strength", 0.62))))
    if strength < 0.4:
        strength_direction = (
            "very conservative material refinement; preserve proxy silhouettes and colors closely"
        )
    elif strength < 0.7:
        strength_direction = (
            "balanced photorealistic material and asset refinement while preserving every footprint"
        )
    else:
        strength_direction = (
            "strong photorealistic material and asset refinement, but geometry remains completely locked"
        )
    return (
        "Photorealistic premium 3D architectural visualization, orthographic axonometric "
        "cutaway dollhouse of the complete furnished apartment, no ceiling, isolated on a "
        "clean white background. The first input image is the authoritative structure. "
        "Keep exactly the same floor plate, room count, wall topology, openings, camera, "
        "furniture count, furniture locations and approximate footprints. Do not move, add "
        "or remove walls, doors, windows, rooms or furniture. Replace only blockout proxy "
        "appearance with believable full-size residential assets, physically based materials, "
        "visible wood grain and fabric weave, soft daylight, global illumination, ambient "
        "occlusion, realistic contact shadows and crisp high-end archviz detail. Avoid text, "
        "watermarks, people, perspective changes, cropped rooms, floating or duplicate furniture. "
        f"Visual restyling strength is {round(strength * 100)}%: {strength_direction}. This strength "
        "may affect only appearance, materials, lighting and asset detail, never layout or geometry. "
        f"Interior design direction: {style_prompt}. {payload.get('design_prompt', '')}"
    ).strip()


def _kuyao_enhance(
    base_path: Path,
    payload: dict[str, Any],
) -> EnhancementResult:
    base = read_image(base_path)
    reference_paths: list[Path] = []
    if settings.kuyao_style_reference_image:
        reference = Path(settings.kuyao_style_reference_image).expanduser()
        if reference.is_file():
            reference_paths.append(reference)
    result = edit_floorplan_image(
        base_path,
        api_key=settings.floorplan_vision_api_key,
        base_url=settings.kuyao_base_url,
        prompt=_enhancement_prompt(payload),
        model=settings.kuyao_image_model,
        size=f"{base.shape[1]}x{base.shape[0]}",
        quality=settings.kuyao_image_quality,
        timeout_seconds=settings.kuyao_image_timeout_seconds,
        reference_paths=reference_paths,
    )
    return EnhancementResult(
        image=read_image(Path(result["path"])),
        provider="kuyao-gpt-image-2",
        model_revision=str(result["model"]),
        notice=(
            "已通过 Kuyao gpt-image-2 写实增强并执行结构校验；"
            "seed 仅作为审计元数据，当前 Kuyao 接口不支持确定性 seed。"
        ),
        requested=True,
        seed=int(payload.get("enhancement_seed", 17)),
        mode="kuyao-image-edit",
        control_image="base-rgb",
        control_model=None,
        seed_mode="audit-only",
    )


def _direct_generation_prompt(payload: dict[str, Any]) -> str:
    layout = payload.get("semantic_layout") or {}
    rooms = layout.get("rooms") if isinstance(layout, dict) else []
    openings = layout.get("openings") if isinstance(layout, dict) else []
    furniture = layout.get("furniture") if isinstance(layout, dict) else []
    room_names = ", ".join(
        f"{item.get('name', item.get('id', 'room'))}({item.get('type', 'other')})"
        for item in rooms[:40]
        if isinstance(item, dict)
    )
    furniture_counts: dict[str, int] = {}
    for item in furniture:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("type", "other"))
        furniture_counts[kind] = furniture_counts.get(kind, 0) + 1
    furniture_summary = ", ".join(
        f"{kind}×{count}" for kind, count in sorted(furniture_counts.items())
    )
    style_prompt = STYLE_PROMPTS.get(
        payload.get("style_preset_id"),
        STYLE_PROMPTS["modern_warm_v1"],
    )
    strength = min(0.9, max(0.2, float(payload.get("enhancement_strength", 0.62))))
    return (
        "Create one premium photorealistic orthographic axonometric cutaway dollhouse render "
        "of the complete apartment, no ceiling, fully visible and uncropped on a clean white "
        "background. Input image 1 is the authoritative original floor plan: preserve its exact "
        "room count, adjacency, outer boundary, walls, doors, windows, furniture count, furniture "
        "locations, rotations and approximate footprints. Input image 2 is the authoritative "
        "semantic constraint map derived from the human-reviewed semanticLayout: blue lines are "
        "walls, colored spans are openings, pastel polygons are rooms and green rectangles are "
        "furniture anchors. Use it only for geometry and object placement, never as an art style. "
        "Any later input image is style-only and must not change the apartment layout. Do not add, "
        "remove, merge or move rooms, walls, openings or furniture. Keep a near-top-down fixed "
        "strict orthographic camera with only a small amount of wall elevation. Both floor-plan "
        "axes must remain parallel across the complete image; do not introduce converging walls, "
        "keystone distortion, perspective orbit, rotation, skew, cropped rooms, "
        "text, dimensions, people, floating furniture, duplicates or watermarks. Replace plan "
        "symbols with believable full-size residential assets and apply physically based materials, "
        "soft daylight, global illumination, ambient occlusion, contact shadows, wood grain and "
        "fabric detail. "
        f"Rooms: {room_names or 'follow the two structure inputs exactly'}. "
        f"Openings: {len(openings)}. Furniture anchors: {furniture_summary or 'follow input 1 exactly'}. "
        f"Appearance restyling strength: {round(strength * 100)}%; this may affect only appearance, "
        "materials, lighting and asset detail, never geometry. "
        f"Interior direction: {style_prompt}. {payload.get('design_prompt', '')}"
    ).strip()


def _kuyao_direct_generate(
    source_path: Path,
    semantic_path: Path,
    payload: dict[str, Any],
) -> EnhancementResult:
    reference_paths = [semantic_path]
    if settings.kuyao_style_reference_image:
        reference = Path(settings.kuyao_style_reference_image).expanduser()
        if reference.is_file() and reference.resolve() not in {
            source_path.resolve(),
            semantic_path.resolve(),
        }:
            reference_paths.append(reference)
    result = edit_floorplan_image(
        source_path,
        api_key=settings.floorplan_vision_api_key,
        base_url=settings.kuyao_base_url,
        prompt=_direct_generation_prompt(payload),
        model=settings.kuyao_image_model,
        size="1536x1024",
        quality=settings.kuyao_image_quality,
        timeout_seconds=settings.kuyao_image_timeout_seconds,
        reference_paths=reference_paths,
    )
    return EnhancementResult(
        image=read_image(Path(result["path"])),
        provider="kuyao-gpt-image-2",
        model_revision=str(result["model"]),
        notice=(
            "已跳过 Blender，使用原始平面图、人工确认的 Semantic 结构图和风格参考图"
            "直接生成全屋鸟瞰效果图；结构指标为生成后审计结果。"
        ),
        requested=True,
        seed=int(payload.get("enhancement_seed", 17)),
        mode="kuyao-ai-direct",
        control_image="source-floorplan+semantic-layout",
        control_model=None,
        seed_mode="audit-only",
    )


def _http_enhance(
    base_path: Path,
    controls: dict[str, Path],
    payload: dict[str, Any],
) -> EnhancementResult:
    if not settings.floorplan_ai_endpoint.startswith(("http://", "https://")):
        raise ValueError("FLOORPLAN_AI_ENDPOINT 必须使用 http 或 https")
    prompt = _enhancement_prompt(payload)
    request_body = {
        "version": "1.0",
        "prompt": prompt,
        "negativePrompt": (
            "white clay render, gray box, blockout, low-poly, primitive cubes, untextured "
            "surfaces, flat materials, plastic toy, empty apartment, schematic floor plan, "
            "cartoon, illustration, game asset, changed wall topology, moved walls, extra "
            "rooms, missing rooms, collapsed partitions, perspective camera, cropped "
            "apartment, floating furniture, duplicate furniture, people, text, watermark, "
            "scribbles, sketch lines, black contour lines, tangled wires, wall cracks, marble "
            "veins, random wall decoration, blur, noise, overexposure"
        ),
        "strength": payload.get("enhancement_strength", 0.62),
        "seed": payload.get("enhancement_seed", 17),
        "controlPriority": ["depth", "edge", "normal", "semantic"],
        "images": {
            "base": _png_data_url(base_path),
            **{
                name: _png_data_url(path)
                for name, path in controls.items()
                if path.exists()
            },
        },
    }
    request = urllib.request.Request(
        settings.floorplan_ai_endpoint,
        data=json.dumps(request_body).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            **(
                {"Authorization": f"Bearer {settings.floorplan_ai_token}"}
                if settings.floorplan_ai_token
                else {}
            ),
        },
    )
    with urllib.request.urlopen(  # noqa: S310 - operator-configured endpoint
        request,
        timeout=settings.floorplan_ai_timeout_seconds,
    ) as response:
        content_type = response.headers.get("Content-Type", "")
        raw = response.read(25 * 1024 * 1024 + 1)
    if len(raw) > 25 * 1024 * 1024:
        raise ValueError("增强服务响应超过 25 MB")
    if content_type.startswith("image/"):
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("增强服务返回的图片无法解码")
        provider_name = "configured-http-provider"
        model_revision = "unknown"
        result_seed = int(payload.get("enhancement_seed", 17))
        result_mode = "configured-http"
        control_image = None
        control_model = None
    else:
        response_payload = json.loads(raw.decode("utf-8"))
        image = _decode_provider_image(response_payload)
        provider_name = response_payload.get("provider", "configured-http-provider")
        model_revision = response_payload.get("modelRevision", "unknown")
        result_seed = int(
            response_payload.get("seed", payload.get("enhancement_seed", 17))
        )
        result_mode = str(response_payload.get("mode", "configured-http"))
        control_image = response_payload.get("controlImage")
        control_model = response_payload.get("controlModel")
    return EnhancementResult(
        image=image,
        provider=provider_name,
        model_revision=model_revision,
        notice="已通过配置的受控生成服务增强，仍需结构一致性校验。",
        requested=True,
        seed=result_seed,
        mode=result_mode,
        control_image=control_image,
        control_model=control_model,
        seed_mode="provider-parameter",
    )


def _local_enhance(
    base: np.ndarray,
    *,
    requested: bool,
    reason: str = "",
    seed: int = 17,
) -> EnhancementResult:
    # This deliberately remains conservative. It improves presentation while
    # keeping every pixel registered to the Blender render.
    lab = cv2.cvtColor(base, cv2.COLOR_BGR2LAB)
    lightness, channel_a, channel_b = cv2.split(lab)
    lightness = cv2.createCLAHE(clipLimit=1.25, tileGridSize=(12, 12)).apply(lightness)
    graded = cv2.cvtColor(
        cv2.merge((lightness, channel_a, channel_b)),
        cv2.COLOR_LAB2BGR,
    )
    smooth = cv2.bilateralFilter(graded, 5, 24, 24)
    blurred = cv2.GaussianBlur(smooth, (0, 0), 1.1)
    enhanced = cv2.addWeighted(smooth, 1.16, blurred, -0.16, 0)
    hsv = cv2.cvtColor(enhanced, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[:, :, 1] = np.clip(hsv[:, :, 1] * 1.045, 0, 255)
    hsv[:, :, 2] = np.clip(hsv[:, :, 2] * 1.018, 0, 255)
    enhanced = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    notice = "本地结构保真增强已完成；配置外部生成服务后才能获得生成式写实细节。"
    if reason:
        notice += f" 外部服务未使用：{reason}"
    return EnhancementResult(
        image=enhanced,
        provider="local-structure-preserving-v2",
        model_revision="opencv-registered-grade-v2",
        notice=notice,
        requested=requested,
        seed=seed,
        mode="registered-local-fallback",
    )


def edge_control(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    return cv2.Canny(gray, 48, 128)


def _ordered_content_quad(image: np.ndarray) -> np.ndarray | None:
    """Find the isolated dollhouse footprint without using furniture features."""
    edges = edge_control(image)
    connected = cv2.dilate(edges, np.ones((9, 9), dtype=np.uint8), iterations=1)
    contours, _ = cv2.findContours(connected, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    hull = cv2.convexHull(contour)
    if cv2.contourArea(hull) < image.shape[0] * image.shape[1] * 0.2:
        return None
    perimeter = cv2.arcLength(hull, True)
    quad: np.ndarray | None = None
    for epsilon in (0.008, 0.01, 0.015, 0.02, 0.03):
        candidate = cv2.approxPolyDP(hull, epsilon * perimeter, True)
        if len(candidate) == 4:
            quad = candidate[:, 0, :].astype(np.float32)
            break
    if quad is None:
        return None

    coordinate_sum = quad.sum(axis=1)
    coordinate_difference = np.diff(quad, axis=1).reshape(-1)
    ordered = np.array(
        [
            quad[np.argmin(coordinate_sum)],
            quad[np.argmin(coordinate_difference)],
            quad[np.argmax(coordinate_sum)],
            quad[np.argmax(coordinate_difference)],
        ],
        dtype=np.float32,
    )
    if len({tuple(point) for point in ordered.tolist()}) != 4:
        return None
    return ordered


def _quad_registration(
    base: np.ndarray,
    result: np.ndarray,
) -> tuple[np.ndarray, dict[str, float]] | None:
    base_quad = _ordered_content_quad(base)
    result_quad = _ordered_content_quad(result)
    if base_quad is None or result_quad is None:
        return None

    def dimensions(quad: np.ndarray) -> tuple[float, float, float, float, float]:
        top = float(np.linalg.norm(quad[1] - quad[0]))
        right = float(np.linalg.norm(quad[2] - quad[1]))
        bottom = float(np.linalg.norm(quad[2] - quad[3]))
        left = float(np.linalg.norm(quad[3] - quad[0]))
        rotation = math.degrees(
            math.atan2(float(quad[1, 1] - quad[0, 1]), float(quad[1, 0] - quad[0, 0]))
        )
        return (top + bottom) / 2, (left + right) / 2, top / bottom, left / right, rotation

    base_width, base_height, base_horizontal_ratio, base_vertical_ratio, base_rotation = (
        dimensions(base_quad)
    )
    result_width, result_height, result_horizontal_ratio, result_vertical_ratio, result_rotation = (
        dimensions(result_quad)
    )
    if min(base_width, base_height, result_width, result_height) <= 1:
        return None
    scale_x = base_width / result_width
    scale_y = base_height / result_height
    anisotropy = max(scale_x, scale_y) / min(scale_x, scale_y) - 1
    rotation_delta = (base_rotation - result_rotation + 90) % 180 - 90
    perspective_ratio = max(
        abs(base_horizontal_ratio),
        abs(1 / base_horizontal_ratio),
        abs(base_vertical_ratio),
        abs(1 / base_vertical_ratio),
        abs(result_horizontal_ratio),
        abs(1 / result_horizontal_ratio),
        abs(result_vertical_ratio),
        abs(1 / result_vertical_ratio),
    )
    if (
        not 0.65 <= scale_x <= 1.55
        or not 0.65 <= scale_y <= 1.55
        or anisotropy > 0.15
        or abs(rotation_delta) > 8
        or perspective_ratio > 1.35
    ):
        return None

    transform = cv2.getPerspectiveTransform(result_quad, base_quad)
    if not np.all(np.isfinite(transform)):
        return None
    registered = cv2.warpPerspective(
        result,
        transform,
        (base.shape[1], base.shape[0]),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )
    return registered, {
        "registrationScaleX": round(scale_x, 4),
        "registrationScaleY": round(scale_y, 4),
        "registrationAnisotropy": round(anisotropy, 4),
        "registrationRotationDeg": round(rotation_delta, 3),
        "registrationPerspectiveRatio": round(perspective_ratio, 4),
    }


def _semantic_wall_edges(semantic_control: np.ndarray, base_shape: tuple[int, ...]) -> np.ndarray | None:
    if semantic_control.shape[:2] != base_shape[:2]:
        return None
    hsv = cv2.cvtColor(semantic_control, cv2.COLOR_BGR2HSV)
    # Blender semantic wall material is RGB (0.18, 0.48, 0.92), rendered near
    # HSV (104, 132, 245). The range includes anti-aliased wall boundaries but
    # excludes cyan plumbing, green beds and the neutral floor/background.
    wall_mask = cv2.inRange(hsv, (98, 80, 170), (112, 210, 255))
    wall_mask = cv2.morphologyEx(
        wall_mask,
        cv2.MORPH_CLOSE,
        np.ones((3, 3), dtype=np.uint8),
    )
    if int(np.count_nonzero(wall_mask)) < base_shape[0] * base_shape[1] * 0.002:
        return None
    wall_edges = cv2.Canny(wall_mask, 30, 100)
    if int(np.count_nonzero(wall_edges)) < 200:
        return None
    return wall_edges


def _semantic_structure_consistency(
    base: np.ndarray,
    result: np.ndarray,
    semantic_control: np.ndarray,
    *,
    tolerance_px: int,
) -> tuple[dict[str, Any], np.ndarray] | None:
    wall_edges = _semantic_wall_edges(semantic_control, base.shape)
    if wall_edges is None:
        return None
    registration = _quad_registration(base, result)
    if registration is None:
        input_size_matches = result.shape[:2] == base.shape[:2]
        diagnostic = (
            result
            if input_size_matches
            else cv2.resize(result, (base.shape[1], base.shape[0]), interpolation=cv2.INTER_AREA)
        )
        diagnostic_edges = edge_control(diagnostic)
        diagnostic_distance = cv2.distanceTransform(255 - diagnostic_edges, cv2.DIST_L2, 3)
        semantic_tolerance = max(tolerance_px, round(max(base.shape[:2]) * 0.013))
        wall_pixels = wall_edges > 0
        wall_retention = float(np.mean(diagnostic_distance[wall_pixels] <= semantic_tolerance))
        return (
            {
                "inputSizeMatches": input_size_matches,
                "outputSizeMatches": input_size_matches,
                "edgeRetention": round(wall_retention, 4),
                "layoutDriftScore": round(max(0.0, 1.0 - wall_retention), 4),
                "passed": False,
                "registrationApplied": False,
                "registrationMode": "semantic-wall-registration-rejected",
                "semanticWallRetention": round(wall_retention, 4),
                "localWallRetention": 0.0,
                "localWallRetentionQ20": 0.0,
                "wallTileCount": 0,
                "wallTolerancePx": semantic_tolerance,
            },
            diagnostic,
        )
    registered, registration_metrics = registration
    result_edges = edge_control(registered)
    distance_to_result = cv2.distanceTransform(255 - result_edges, cv2.DIST_L2, 3)
    wall_pixels = wall_edges > 0
    semantic_tolerance = max(tolerance_px, round(max(base.shape[:2]) * 0.013))
    retained = distance_to_result[wall_pixels] <= semantic_tolerance
    wall_retention = float(np.mean(retained))

    x, y, width, height = cv2.boundingRect(cv2.findNonZero(wall_edges))
    tile_retentions: list[float] = []
    minimum_tile_pixels = max(24, round(int(np.count_nonzero(wall_pixels)) * 0.008))
    for row in range(4):
        for column in range(4):
            x1 = x + column * width // 4
            x2 = x + (column + 1) * width // 4
            y1 = y + row * height // 4
            y2 = y + (row + 1) * height // 4
            tile_mask = wall_pixels[y1:y2, x1:x2]
            if int(np.count_nonzero(tile_mask)) < minimum_tile_pixels:
                continue
            tile_retentions.append(
                float(np.mean(distance_to_result[y1:y2, x1:x2][tile_mask] <= semantic_tolerance))
            )
    local_minimum = min(tile_retentions) if tile_retentions else 0.0
    local_quantile = (
        float(np.quantile(np.asarray(tile_retentions), 0.2)) if tile_retentions else 0.0
    )
    passed = (
        wall_retention >= 0.82
        and len(tile_retentions) >= 4
        and local_minimum >= 0.6
        and local_quantile >= 0.72
    )
    return (
        {
            "inputSizeMatches": result.shape[:2] == base.shape[:2],
            "outputSizeMatches": True,
            "edgeRetention": round(wall_retention, 4),
            "layoutDriftScore": round(max(0.0, 1.0 - wall_retention), 4),
            "passed": passed,
            "registrationApplied": True,
            "registrationMode": "semantic-wall-homography",
            "semanticWallRetention": round(wall_retention, 4),
            "localWallRetention": round(local_minimum, 4),
            "localWallRetentionQ20": round(local_quantile, 4),
            "wallTileCount": len(tile_retentions),
            "wallTolerancePx": semantic_tolerance,
            **registration_metrics,
        },
        registered,
    )


def _evaluate_structure_consistency(
    base: np.ndarray,
    result: np.ndarray,
    *,
    tolerance_px: int,
    semantic_control: np.ndarray | None,
) -> tuple[dict[str, Any], np.ndarray]:
    if semantic_control is not None:
        semantic_result = _semantic_structure_consistency(
            base,
            result,
            semantic_control,
            tolerance_px=tolerance_px,
        )
        if semantic_result is not None:
            return semantic_result

    input_size_matches = result.shape[:2] == base.shape[:2]
    if not input_size_matches:
        result = cv2.resize(result, (base.shape[1], base.shape[0]), interpolation=cv2.INTER_AREA)
    base_edges = edge_control(base)
    result_edges = edge_control(result)
    distance_to_result = cv2.distanceTransform(255 - result_edges, cv2.DIST_L2, 3)
    structural_pixels = base_edges > 0
    retention = (
        1.0
        if not np.any(structural_pixels)
        else float(np.mean(distance_to_result[structural_pixels] <= tolerance_px))
    )
    return (
        {
            "inputSizeMatches": input_size_matches,
            "outputSizeMatches": input_size_matches,
            "edgeRetention": round(retention, 4),
            "layoutDriftScore": round(max(0.0, 1.0 - retention), 4),
            "passed": input_size_matches and retention >= 0.72,
            "registrationApplied": False,
            "registrationMode": "pixel-registered-legacy",
        },
        result,
    )


def structure_consistency(
    base: np.ndarray,
    result: np.ndarray,
    *,
    tolerance_px: int = 4,
    semantic_control: np.ndarray | None = None,
) -> dict[str, Any]:
    consistency, _ = _evaluate_structure_consistency(
        base,
        result,
        tolerance_px=tolerance_px,
        semantic_control=semantic_control,
    )
    return consistency


def enhance_floorplan_render(
    base_path: Path,
    controls: dict[str, Path],
    payload: dict[str, Any],
) -> dict[str, Any]:
    base = read_image(base_path)
    semantic_control: np.ndarray | None = None
    semantic_path = controls.get("semantic")
    if semantic_path is not None and semantic_path.is_file():
        try:
            semantic_control = read_image(semantic_path)
        except ProcessorError:
            semantic_control = None
    seed = int(payload.get("enhancement_seed", 17))
    requested = bool(payload.get("enable_enhancement", True))
    final_requested = requested and payload.get("render_quality", "base") == "final"
    kuyao_requested = final_requested and settings.kuyao_image_edit_configured
    external_requested = (
        final_requested
        and bool(settings.floorplan_ai_endpoint)
    )
    if kuyao_requested:
        try:
            candidate = _kuyao_enhance(base_path, payload)
        except ProcessorError as exc:
            if external_requested:
                try:
                    candidate = _http_enhance(base_path, controls, payload)
                except (
                    OSError,
                    TimeoutError,
                    ValueError,
                    json.JSONDecodeError,
                    urllib.error.URLError,
                ) as fallback_exc:
                    candidate = _local_enhance(
                        base,
                        requested=True,
                        reason=f"{exc.message}；本地增强桥失败：{fallback_exc}",
                        seed=seed,
                    )
            else:
                candidate = _local_enhance(
                    base,
                    requested=True,
                    reason=exc.message,
                    seed=seed,
                )
    elif external_requested:
        try:
            candidate = _http_enhance(base_path, controls, payload)
        except (
            OSError,
            TimeoutError,
            ValueError,
            json.JSONDecodeError,
            urllib.error.URLError,
        ) as exc:
            candidate = _local_enhance(
                base,
                requested=True,
                reason=str(exc),
                seed=seed,
            )
    else:
        reason = ""
        if requested and payload.get("render_quality", "base") == "final":
            reason = "未配置 FLOORPLAN_AI_ENDPOINT"
        candidate = _local_enhance(
            base,
            requested=requested,
            reason=reason,
            seed=seed,
        )

    enhancement_strength = float(payload.get("enhancement_strength", 0.62))
    consistency_tolerance = 6 if enhancement_strength >= 0.55 else 4
    consistency, registered_candidate = _evaluate_structure_consistency(
        base,
        candidate.image,
        tolerance_px=consistency_tolerance,
        semantic_control=semantic_control,
    )
    candidate.image = registered_candidate
    rejected_provider: str | None = None
    if (
        candidate.provider != "local-structure-preserving-v2"
        and not consistency["passed"]
    ):
        rejected_provider = candidate.provider
        candidate = _local_enhance(
            base,
            requested=True,
            reason="生成结果未通过结构一致性检查，已自动回退",
            seed=seed,
        )
        consistency, registered_candidate = _evaluate_structure_consistency(
            base,
            candidate.image,
            tolerance_px=consistency_tolerance,
            semantic_control=semantic_control,
        )
        candidate.image = registered_candidate
    if candidate.image.shape[:2] != base.shape[:2]:
        candidate.image = cv2.resize(
            candidate.image,
            (base.shape[1], base.shape[0]),
            interpolation=cv2.INTER_LANCZOS4,
        )
    output = write_image("floorplan-final-render", candidate.image)
    return {
        "path": output,
        "url": artifact_url(output),
        "provider": candidate.provider,
        "modelRevision": candidate.model_revision,
        "notice": candidate.notice,
        "requested": candidate.requested,
        "seed": candidate.seed,
        "seedMode": candidate.seed_mode,
        "mode": candidate.mode,
        "controlImage": candidate.control_image,
        "controlModel": candidate.control_model,
        "rejectedProvider": rejected_provider,
        "consistency": consistency,
    }


def generate_direct_floorplan_render(
    source_path: Path,
    semantic_path: Path,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Generate a final dollhouse directly from reviewed 2D structure references."""
    if not settings.kuyao_image_edit_configured:
        raise ProcessorError(
            "AI_DIRECT_UNAVAILABLE",
            "AI 直出需要配置 Kuyao gpt-image-2；也可以切换到精确三维模式",
        )
    base = read_image(source_path)
    semantic_control = read_image(semantic_path)
    candidate = _kuyao_direct_generate(source_path, semantic_path, payload)
    consistency, _registered_candidate = _evaluate_structure_consistency(
        base,
        candidate.image,
        tolerance_px=8,
        semantic_control=semantic_control,
    )
    # Homography is useful for measuring whether the generated walls correspond
    # to the flat reference, but applying that transform to a photorealistic
    # image creates visible rotation, anisotropic stretching and keystone skew.
    # Keep it audit-only for AI-direct output and publish the provider image
    # without geometric deformation.
    consistency = dict(consistency)
    consistency["auditRegistrationApplied"] = consistency.get(
        "registrationApplied", False
    )
    consistency["auditRegistrationMode"] = consistency.get("registrationMode")
    consistency["registrationApplied"] = False
    consistency["registrationMode"] = "semantic-wall-audit-only"
    consistency["outputTransformApplied"] = False
    if not consistency["passed"]:
        candidate.notice += (
            " 当前结果未达到墙体自动审计阈值，已保留未变形候选图；"
            "页面将标记为结构复核，不能作为已通过成品使用。"
        )
    if candidate.image.shape[:2] != base.shape[:2]:
        candidate_height, candidate_width = candidate.image.shape[:2]
        output_height, output_width = base.shape[:2]
        output_scale = min(
            output_width / candidate_width,
            output_height / candidate_height,
        )
        fitted_width = max(1, round(candidate_width * output_scale))
        fitted_height = max(1, round(candidate_height * output_scale))
        fitted = cv2.resize(
            candidate.image,
            (fitted_width, fitted_height),
            interpolation=(
                cv2.INTER_AREA if output_scale < 1 else cv2.INTER_LANCZOS4
            ),
        )
        canvas = np.full_like(base, 255)
        offset_x = (output_width - fitted_width) // 2
        offset_y = (output_height - fitted_height) // 2
        canvas[
            offset_y : offset_y + fitted_height,
            offset_x : offset_x + fitted_width,
        ] = fitted
        candidate.image = canvas
    consistency["outputSizeMatches"] = candidate.image.shape[:2] == base.shape[:2]
    output = write_image("floorplan-ai-direct-final", candidate.image)
    return {
        "path": output,
        "url": artifact_url(output),
        "provider": candidate.provider,
        "modelRevision": candidate.model_revision,
        "notice": candidate.notice,
        "requested": True,
        "seed": candidate.seed,
        "seedMode": candidate.seed_mode,
        "mode": candidate.mode,
        "controlImage": candidate.control_image,
        "controlModel": None,
        "rejectedProvider": None,
        "consistency": consistency,
    }
