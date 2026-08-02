from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


def to_camel(value: str) -> str:
    return re.sub(r"_([a-z])", lambda match: match.group(1).upper(), value)


class APIModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,
    )


class ProjectCreate(APIModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)


class ProjectRead(ProjectCreate):
    id: str
    created_at: datetime


class JobRead(APIModel):
    id: str
    project_id: str | None = None
    parent_job_id: str | None = None
    type: str
    status: Literal["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"]
    payload: dict[str, Any]
    result: dict[str, Any] | None = None
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime
    updated_at: datetime


class SceneAssetRead(APIModel):
    id: str
    owner_id: str
    project_id: str | None = None
    job_id: str
    parent_asset_id: str | None = None
    title: str
    generation_mode: str
    asset_type: str
    module_key: Literal[
        "floorplan",
        "layout",
        "white_model",
        "effect_render",
        "material_replacement",
    ]
    module_name: str
    thumbnail_url: str | None = None
    deliverables: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class SceneAssetDetail(SceneAssetRead):
    source_payload: dict[str, Any] = Field(default_factory=dict)
    source_result: dict[str, Any] = Field(default_factory=dict)


class AssetModuleRead(APIModel):
    key: Literal[
        "floorplan",
        "layout",
        "white_model",
        "effect_render",
        "material_replacement",
    ]
    name: str
    description: str


class SceneAssetRenderRequest(APIModel):
    variant_type: Literal["camera", "material"]
    camera_preset_id: Literal["corner_01", "corner_02", "eye_level_01"] | None = None
    style_preset_id: Literal[
        "modern_warm_v1",
        "modern_minimal_v1",
        "natural_wood_v1",
    ] | None = None
    render_quality: Literal["base", "final"] = "base"

    @model_validator(mode="after")
    def validate_variant_target(self) -> SceneAssetRenderRequest:
        if self.variant_type == "camera" and not self.camera_preset_id:
            raise ValueError("camera 版本必须提供 cameraPresetId")
        if self.variant_type == "material" and not self.style_preset_id:
            raise ValueError("material 版本必须提供 stylePresetId")
        return self


class EffectRenderRequest(APIModel):
    project_id: str | None = None
    room_type: Literal["living_room", "dining_room", "bedroom"] = "living_room"
    width_mm: int = Field(default=5200, ge=2400, le=12000)
    depth_mm: int = Field(default=4200, ge=2400, le=12000)
    ceiling_height_mm: int = Field(default=2800, ge=2200, le=4500)
    style_preset_id: str = "modern_warm_v1"
    camera_preset_id: str = "corner_01"
    placements: list[dict[str, Any]] = Field(default_factory=list)
    use_blender: bool = True


class PixelBounds(APIModel):
    x: float = Field(ge=0)
    y: float = Field(ge=0)
    width: float = Field(gt=0)
    height: float = Field(gt=0)


class FloorplanWall(APIModel):
    id: str = Field(min_length=1, max_length=80)
    x1: float = Field(ge=0)
    y1: float = Field(ge=0)
    x2: float = Field(ge=0)
    y2: float = Field(ge=0)
    source: Literal["auto", "manual", "semantic"] = "auto"


class FloorplanSceneRequest(APIModel):
    project_id: str | None = None
    schema_version: Literal["0.2", "0.3", "0.4", "0.5"] = "0.5"
    source_image_url: str
    image_width: int = Field(ge=320, le=10000)
    image_height: int = Field(ge=240, le=10000)
    plan_width_mm: int = Field(ge=2400, le=30000)
    plan_depth_mm: int = Field(ge=2400, le=30000)
    ceiling_height_mm: int = Field(default=2800, ge=2200, le=4500)
    wall_thickness_mm: int = Field(default=100, ge=60, le=500)
    detected_bounds: PixelBounds
    walls: list[FloorplanWall] = Field(min_length=4, max_length=500)
    semantic_layout: dict[str, Any] | None = None
    semantic_review_confirmed: bool = False
    room_selection: PixelBounds
    room_name: str = Field(default="客餐厅", min_length=1, max_length=40)
    style_preset_id: str = "modern_warm_v1"
    camera_preset_id: str = "corner_01"
    layout_preset_id: Literal["auto", "studio", "one_bedroom", "two_bedroom"] = "auto"
    generation_mode: Literal["ai_direct", "structured_3d"] = "structured_3d"
    render_quality: Literal["preview", "base", "final"] = "base"
    enable_enhancement: bool = True
    enhancement_strength: float = Field(default=0.62, ge=0.2, le=0.9)
    enhancement_seed: int = Field(default=17, ge=0, le=9_223_372_036_854_775_807)
    design_prompt: str = Field(default="", max_length=500)
    use_blender: bool = True


class CameraPreset(APIModel):
    id: str
    name: str
    description: str
