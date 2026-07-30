from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


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


class LayoutRequest(APIModel):
    project_id: str | None = None
    room_type: Literal["living_room", "dining_room", "bedroom"] = "living_room"
    width_mm: int = Field(default=5200, ge=2400, le=12000)
    depth_mm: int = Field(default=4200, ge=2400, le=12000)
    sofa_seats: int = Field(default=3, ge=2, le=5)
    dining_seats: int = Field(default=4, ge=2, le=8)
    bed_type: Literal["bed_1500", "bed_1800"] = "bed_1800"
    count: int = Field(default=2, ge=1, le=2)


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
    source: Literal["auto", "manual"] = "auto"


class FloorplanSceneRequest(APIModel):
    project_id: str | None = None
    schema_version: Literal["0.2"] = "0.2"
    source_image_url: str
    image_width: int = Field(ge=320, le=10000)
    image_height: int = Field(ge=240, le=10000)
    plan_width_mm: int = Field(ge=2400, le=30000)
    plan_depth_mm: int = Field(ge=2400, le=30000)
    ceiling_height_mm: int = Field(default=2800, ge=2200, le=4500)
    wall_thickness_mm: int = Field(default=100, ge=60, le=500)
    detected_bounds: PixelBounds
    walls: list[FloorplanWall] = Field(min_length=4, max_length=160)
    room_selection: PixelBounds
    room_name: str = Field(default="客餐厅", min_length=1, max_length=40)
    style_preset_id: str = "modern_warm_v1"
    camera_preset_id: str = "corner_01"
    use_blender: bool = True


class CameraPreset(APIModel):
    id: str
    name: str
    description: str

