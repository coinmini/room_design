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
    design_prompt: str | None = Field(default=None, max_length=2000)
    cover_url: str | None = Field(default=None, max_length=500)


class ProjectUpdate(APIModel):
    """部分更新；至少提供一个字段。"""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    design_prompt: str | None = Field(default=None, max_length=2000)
    cover_url: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def require_at_least_one_field(self) -> ProjectUpdate:
        if (
            self.name is None
            and self.description is None
            and self.design_prompt is None
            and self.cover_url is None
        ):
            raise ValueError("至少提供一个待更新字段")
        return self


class ProjectRead(ProjectCreate):
    id: str
    created_at: datetime
    updated_at: datetime | None = None


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
    started_at: datetime | None = None
    finished_at: datetime | None = None
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
        "ai_workflow",
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


class WorkflowResumeAsset(APIModel):
    """Public, path-free inputs required to continue an approved AI workflow asset."""

    asset_id: str
    job_id: str
    project_id: str | None = None
    parent_asset_id: str | None = None
    module_key: Literal["layout", "ai_workflow"]
    workflow_stage: Literal[
        "layout",
        "color_plan",
        "axonometric",
        "space_render",
        "style_scheme",
        "tone_scheme",
        "local_edit",
    ]
    approval_status: Literal["approved"]
    approved_variant_id: str
    approved_version_id: str
    approved_output_url: str
    approved_output_sha256: str | None = None
    semantic_layout: dict[str, Any]
    approved_layout_asset_id: str | None = None
    approved_layout_version_id: str | None = None
    approved_layout_image_url: str | None = None
    approved_color_plan_asset_id: str | None = None
    approved_color_plan_version_id: str | None = None
    approved_color_plan_image_url: str | None = None
    source_space_image_url: str | None = None
    space_id: str | None = None
    space_name: str | None = None
    eligible_next_stages: list[
        Literal[
            "color_plan",
            "axonometric",
            "space_render",
            "style_scheme",
            "tone_scheme",
            "local_edit",
        ]
    ] = Field(default_factory=list)
    lineage: dict[str, Any] = Field(default_factory=dict)


class SceneAssetApprovalRequest(APIModel):
    variant_id: str = Field(min_length=1, max_length=160)
    comment: str | None = Field(default=None, max_length=500)


class AssetModuleRead(APIModel):
    key: Literal[
        "floorplan",
        "layout",
        "white_model",
        "effect_render",
        "material_replacement",
        "ai_workflow",
    ]
    name: str
    description: str


class SceneAssetRenderRequest(APIModel):
    variant_type: Literal["camera", "material"]
    camera_preset_id: Literal["corner_01", "corner_02", "eye_level_01"] | None = None
    style_preset_id: (
        Literal[
            "modern_warm_v1",
            "modern_minimal_v1",
            "natural_wood_v1",
        ]
        | None
    ) = None
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


class AIWorkflowJobBase(APIModel):
    """Validated, persisted payload shared by pure-AI workflow stages 3 through 5."""

    project_id: str | None = None
    approved_layout_path: str = Field(min_length=1)
    approved_layout_version_id: str | None = Field(default=None, max_length=120)
    layout_approved: bool
    semantic_layout: dict[str, Any] = Field(min_length=1)
    variant_group_id: str = Field(min_length=1, max_length=80)
    design_prompt: str = Field(default="", max_length=1000)
    style_reference_paths: list[str] = Field(default_factory=list, max_length=7)
    asset_parent_id: str | None = Field(default=None, max_length=40)
    asset_module_key: Literal["ai_workflow"] = "ai_workflow"

    @model_validator(mode="after")
    def validate_layout_approval(self) -> AIWorkflowJobBase:
        if not self.layout_approved:
            raise ValueError("只有已批准的平面布局才能进入后续 AI 设计阶段")
        rooms = self.semantic_layout.get("rooms")
        if not isinstance(rooms, list) or not rooms:
            raise ValueError("semanticLayout 的 rooms 必须是非空数组")
        return self


class AIColorPlanJobPayload(AIWorkflowJobBase):
    workflow_stage: Literal["color_plan"] = "color_plan"
    variants: list[
        Literal[
            "simple_2d",
            "topdown_3d",
            "watercolor",
            "material_realistic",
        ]
    ] = Field(min_length=1, max_length=4)


class AIAxonometricJobPayload(AIWorkflowJobBase):
    workflow_stage: Literal["axonometric"] = "axonometric"
    approved_color_plan_path: str = Field(min_length=1)
    variants: list[Literal["isometric_day", "isometric_night", "alternate_angle"]] = Field(
        min_length=1, max_length=3
    )


class AISpaceRenderJobPayload(AIWorkflowJobBase):
    workflow_stage: Literal["space_render"] = "space_render"
    approved_color_plan_path: str = Field(min_length=1)
    selected_space_ids: list[str] = Field(default_factory=list, max_length=12)
    view_preset: Literal["eye_level_wide", "corner_wide", "straight_on"] = "eye_level_wide"


class AIWorkflowDerivativeJobBase(APIModel):
    """Validated payload shared by the approved-space derivative stages 6 through 8."""

    project_id: str | None = None
    source_space_path: str = Field(min_length=1)
    source_space_version_id: str = Field(min_length=1, max_length=220)
    parent_approved_version_id: str = Field(min_length=1, max_length=220)
    parent_variant_id: str = Field(min_length=1, max_length=160)
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_approved: bool
    semantic_layout: dict[str, Any] = Field(min_length=1)
    space_id: str = Field(min_length=1, max_length=120)
    variant_group_id: str = Field(min_length=1, max_length=80)
    design_prompt: str = Field(default="", max_length=1000)
    asset_parent_id: str = Field(min_length=1, max_length=40)
    asset_module_key: Literal["ai_workflow"] = "ai_workflow"

    @model_validator(mode="after")
    def validate_approved_space(self) -> AIWorkflowDerivativeJobBase:
        if not self.source_approved:
            raise ValueError("只有已批准的空间效果图才能进入风格、色调或局部修改阶段")
        rooms = self.semantic_layout.get("rooms")
        if not isinstance(rooms, list) or not rooms:
            raise ValueError("semanticLayout 的 rooms 必须是非空数组")
        room_ids = {
            room.get("id")
            for room in rooms
            if isinstance(room, dict) and isinstance(room.get("id"), str)
        }
        if self.space_id not in room_ids:
            raise ValueError("spaceId 不属于 semanticLayout.rooms")
        if self.source_space_version_id != self.parent_approved_version_id:
            raise ValueError("sourceSpaceVersionId 与上游批准版本不一致")
        return self


class AIStyleSchemeJobPayload(AIWorkflowDerivativeJobBase):
    workflow_stage: Literal["style_scheme"] = "style_scheme"
    variants: list[
        Literal[
            "modern_minimal",
            "natural_wood",
            "midcentury_vintage",
            "french_luxury",
        ]
    ] = Field(min_length=1, max_length=4)
    style_reference_paths: list[str] = Field(default_factory=list, max_length=7)


class AIToneSchemeJobPayload(AIWorkflowDerivativeJobBase):
    workflow_stage: Literal["tone_scheme"] = "tone_scheme"
    variants: list[
        Literal[
            "warm_gold_day",
            "neutral_dusk",
            "cool_blue_night",
        ]
    ] = Field(min_length=1, max_length=3)


class AILocalEditJobPayload(AIWorkflowDerivativeJobBase):
    workflow_stage: Literal["local_edit"] = "local_edit"
    mark_path: str = Field(min_length=1)
    edit_prompt: str = Field(min_length=1, max_length=1000)


class CanvasCreate(APIModel):
    project_id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=120)
    viewport_json: dict[str, Any] = Field(default_factory=dict)


class CanvasRead(APIModel):
    id: str
    project_id: str
    name: str
    viewport_json: dict[str, Any] = Field(default_factory=dict)
    updated_at: datetime


class CanvasDetail(CanvasRead):
    nodes: list[dict[str, Any]] = Field(default_factory=list)


class CanvasNodeCreate(APIModel):
    canvas_id: str = Field(min_length=1, max_length=40)
    asset_id: str | None = Field(default=None, min_length=1, max_length=40)
    variant_id: str | None = Field(default=None, max_length=160)
    job_id: str | None = Field(default=None, min_length=1, max_length=40)
    x: float = 0.0
    y: float = 0.0
    w: float = 0.0
    h: float = 0.0
    z: int = 0
    source_node_id: str | None = Field(default=None, min_length=1, max_length=40)


class CanvasNodeRead(APIModel):
    id: str
    canvas_id: str
    asset_id: str | None = None
    variant_id: str | None = None
    job_id: str | None = None
    x: float
    y: float
    w: float
    h: float
    z: int
    source_node_id: str | None = None
    created_at: datetime
    updated_at: datetime


class CanvasNodePatch(APIModel):
    x: float | None = None
    y: float | None = None
    w: float | None = None
    h: float | None = None
    z: int | None = None


class CanvasNodeBatchPatch(APIModel):
    nodes: list[dict[str, Any]] = Field(min_length=1)
