from __future__ import annotations

from typing import Any


OUTPUT_NODE_ID = "8"
REQUIRED_NODE_TYPES = {
    "CheckpointLoaderSimple",
    "LoadImage",
    "ImageScale",
    "VAEEncode",
    "CLIPTextEncode",
    "KSampler",
    "VAEDecode",
    "SaveImage",
}

CONTROLNET_NODE_TYPES = {
    "ControlNetLoader",
    "ControlNetApplyAdvanced",
}

IPADAPTER_NODE_TYPES = {
    "IPAdapterModelLoader",
    "CLIPVisionLoader",
    "IPAdapterPreciseStyleTransfer",
}


def build_sdxl_img2img_workflow(
    *,
    checkpoint: str,
    uploaded_image: str,
    prompt: str,
    negative_prompt: str,
    seed: int,
    steps: int,
    cfg: float,
    strength: float,
    sampler_name: str,
    scheduler: str,
    generation_width: int,
    generation_height: int,
    output_width: int,
    output_height: int,
) -> dict[str, dict[str, Any]]:
    """Build the core ComfyUI API-format SDXL img2img graph."""
    return {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": checkpoint},
        },
        "2": {
            "class_type": "LoadImage",
            "inputs": {"image": uploaded_image},
        },
        "9": {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["2", 0],
                "upscale_method": "lanczos",
                "width": generation_width,
                "height": generation_height,
                "crop": "disabled",
            },
        },
        "3": {
            "class_type": "VAEEncode",
            "inputs": {"pixels": ["9", 0], "vae": ["1", 2]},
        },
        "4": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": prompt, "clip": ["1", 1]},
        },
        "5": {
            "class_type": "CLIPTextEncode",
            "inputs": {"text": negative_prompt, "clip": ["1", 1]},
        },
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": sampler_name,
                "scheduler": scheduler,
                "denoise": strength,
                "model": ["1", 0],
                "positive": ["4", 0],
                "negative": ["5", 0],
                "latent_image": ["3", 0],
            },
        },
        "7": {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["6", 0], "vae": ["1", 2]},
        },
        "10": {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["7", 0],
                "upscale_method": "lanczos",
                "width": output_width,
                "height": output_height,
                "crop": "disabled",
            },
        },
        OUTPUT_NODE_ID: {
            "class_type": "SaveImage",
            "inputs": {
                "filename_prefix": "room_design/enhanced",
                "images": ["10", 0],
            },
        },
    }


def build_sdxl_controlnet_img2img_workflow(
    *,
    checkpoint: str,
    uploaded_image: str,
    uploaded_control: str,
    controlnet_model: str,
    prompt: str,
    negative_prompt: str,
    seed: int,
    steps: int,
    cfg: float,
    strength: float,
    control_strength: float,
    control_end_percent: float,
    sampler_name: str,
    scheduler: str,
    generation_width: int,
    generation_height: int,
    output_width: int,
    output_height: int,
) -> dict[str, dict[str, Any]]:
    workflow = build_sdxl_img2img_workflow(
        checkpoint=checkpoint,
        uploaded_image=uploaded_image,
        prompt=prompt,
        negative_prompt=negative_prompt,
        seed=seed,
        steps=steps,
        cfg=cfg,
        strength=strength,
        sampler_name=sampler_name,
        scheduler=scheduler,
        generation_width=generation_width,
        generation_height=generation_height,
        output_width=output_width,
        output_height=output_height,
    )
    workflow.update(
        {
            "11": {
                "class_type": "LoadImage",
                "inputs": {"image": uploaded_control},
            },
            "12": {
                "class_type": "ImageScale",
                "inputs": {
                    "image": ["11", 0],
                    "upscale_method": "lanczos",
                    "width": generation_width,
                    "height": generation_height,
                    "crop": "disabled",
                },
            },
            "13": {
                "class_type": "ControlNetLoader",
                "inputs": {"control_net_name": controlnet_model},
            },
            "14": {
                "class_type": "ControlNetApplyAdvanced",
                "inputs": {
                    "positive": ["4", 0],
                    "negative": ["5", 0],
                    "control_net": ["13", 0],
                    "image": ["12", 0],
                    "strength": control_strength,
                    "start_percent": 0.0,
                    "end_percent": control_end_percent,
                },
            },
        }
    )
    workflow["6"]["inputs"]["positive"] = ["14", 0]
    workflow["6"]["inputs"]["negative"] = ["14", 1]
    return workflow


def add_ipadapter_style_reference(
    workflow: dict[str, dict[str, Any]],
    *,
    uploaded_reference: str,
    ipadapter_model: str,
    clip_vision_model: str,
    weight: float,
    style_boost: float,
    end_percent: float,
) -> dict[str, dict[str, Any]]:
    """Patch the base model with IP-Adapter's precise style-only transfer.

    The reference image affects materials, lighting and rendering language while
    the Blender latent and ControlNet remain responsible for apartment geometry.
    """
    workflow.update(
        {
            "20": {
                "class_type": "LoadImage",
                "inputs": {"image": uploaded_reference},
            },
            "21": {
                "class_type": "IPAdapterModelLoader",
                "inputs": {"ipadapter_file": ipadapter_model},
            },
            "22": {
                "class_type": "CLIPVisionLoader",
                "inputs": {"clip_name": clip_vision_model},
            },
            "23": {
                "class_type": "IPAdapterPreciseStyleTransfer",
                "inputs": {
                    "model": ["1", 0],
                    "ipadapter": ["21", 0],
                    "image": ["20", 0],
                    "weight": weight,
                    "style_boost": style_boost,
                    "combine_embeds": "average",
                    "start_at": 0.0,
                    "end_at": end_percent,
                    "embeds_scaling": "K+V w/ C penalty",
                    "clip_vision": ["22", 0],
                },
            },
        }
    )
    workflow["6"]["inputs"]["model"] = ["23", 0]
    return workflow


def add_sdxl_refiner(
    workflow: dict[str, dict[str, Any]],
    *,
    checkpoint: str,
    prompt: str,
    negative_prompt: str,
    seed: int,
    steps: int,
    cfg: float,
    denoise: float,
    sampler_name: str,
    scheduler: str,
) -> dict[str, dict[str, Any]]:
    """Add a conservative latent-space SDXL Refiner pass after base sampling."""
    workflow.update(
        {
            "30": {
                "class_type": "CheckpointLoaderSimple",
                "inputs": {"ckpt_name": checkpoint},
            },
            "31": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": prompt, "clip": ["30", 1]},
            },
            "32": {
                "class_type": "CLIPTextEncode",
                "inputs": {"text": negative_prompt, "clip": ["30", 1]},
            },
            "33": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": seed,
                    "steps": steps,
                    "cfg": cfg,
                    "sampler_name": sampler_name,
                    "scheduler": scheduler,
                    "denoise": denoise,
                    "model": ["30", 0],
                    "positive": ["31", 0],
                    "negative": ["32", 0],
                    "latent_image": ["6", 0],
                },
            },
        }
    )
    workflow["7"]["inputs"]["samples"] = ["33", 0]
    workflow["7"]["inputs"]["vae"] = ["30", 2]
    return workflow
