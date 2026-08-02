from __future__ import annotations

import os
from dataclasses import dataclass


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    comfyui_url: str = os.getenv("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/")
    checkpoint: str = os.getenv(
        "COMFYUI_CHECKPOINT",
        "sd_xl_base_1.0.safetensors",
    ).strip()
    refiner_checkpoint: str = os.getenv(
        "COMFYUI_REFINER_CHECKPOINT",
        "",
    ).strip()
    refiner_steps: int = min(
        100,
        max(1, _env_int("COMFYUI_REFINER_STEPS", 20)),
    )
    refiner_cfg: float = min(
        30.0,
        max(0.1, _env_float("COMFYUI_REFINER_CFG", 5.0)),
    )
    refiner_denoise: float = min(
        1.0,
        max(0.01, _env_float("COMFYUI_REFINER_DENOISE", 0.20)),
    )
    ipadapter_model: str = os.getenv("COMFYUI_IPADAPTER_MODEL", "").strip()
    ipadapter_clip_vision: str = os.getenv(
        "COMFYUI_IPADAPTER_CLIP_VISION",
        "",
    ).strip()
    ipadapter_reference_image: str = os.getenv(
        "COMFYUI_IPADAPTER_REFERENCE_IMAGE",
        "",
    ).strip()
    ipadapter_weight: float = min(
        5.0,
        max(-1.0, _env_float("COMFYUI_IPADAPTER_WEIGHT", 0.60)),
    )
    ipadapter_style_boost: float = min(
        5.0,
        max(-5.0, _env_float("COMFYUI_IPADAPTER_STYLE_BOOST", 1.10)),
    )
    ipadapter_end_percent: float = min(
        1.0,
        max(0.0, _env_float("COMFYUI_IPADAPTER_END_PERCENT", 0.85)),
    )
    controlnet_model: str = os.getenv("COMFYUI_CONTROLNET_MODEL", "").strip()
    control_image: str = os.getenv("COMFYUI_CONTROL_IMAGE", "auto").strip().lower()
    control_strength: float = min(
        2.0,
        max(0.0, _env_float("COMFYUI_CONTROL_STRENGTH", 0.88)),
    )
    control_end_percent: float = min(
        1.0,
        max(0.0, _env_float("COMFYUI_CONTROL_END_PERCENT", 1.0)),
    )
    timeout_seconds: float = max(1.0, _env_float("COMFYUI_HTTP_TIMEOUT_SECONDS", 15.0))
    generation_timeout_seconds: float = max(
        5.0,
        _env_float("COMFYUI_GENERATION_TIMEOUT_SECONDS", 900.0),
    )
    poll_interval_seconds: float = max(
        0.05,
        _env_float("COMFYUI_POLL_INTERVAL_SECONDS", 0.5),
    )
    steps: int = min(100, max(1, _env_int("COMFYUI_STEPS", 28)))
    cfg: float = min(30.0, max(0.1, _env_float("COMFYUI_CFG", 5.5)))
    sampler_name: str = os.getenv("COMFYUI_SAMPLER", "dpmpp_2m_sde").strip()
    scheduler: str = os.getenv("COMFYUI_SCHEDULER", "karras").strip()
    max_generation_side: int = min(
        2048,
        max(512, _env_int("COMFYUI_MAX_GENERATION_SIDE", 1280)),
    )
    max_image_bytes: int = min(
        50 * 1024 * 1024,
        max(1024, _env_int("ENHANCER_MAX_IMAGE_BYTES", 25 * 1024 * 1024)),
    )


settings = Settings()
