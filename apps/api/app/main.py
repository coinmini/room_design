from __future__ import annotations

from copy import deepcopy
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.assets import (
    LOCAL_OWNER_ID,
    asset_modules,
    backfill_scene_assets,
    get_local_scene_asset,
    scene_asset_detail,
    scene_asset_read,
)
from app.config import WORKSPACE_ROOT, settings
from app.database import get_session, init_db
from app.jobs import create_job, run_job
from app.models import Job, Project, SceneAsset
from app.processors.floorplan_enhancement import enhancement_capability
from app.processors.common import ProcessorError
from app.processors.layout import resolve_ai_layout_template_ids
from app.schemas import (
    AssetModuleRead,
    CameraPreset,
    EffectRenderRequest,
    FloorplanSceneRequest,
    JobRead,
    ProjectCreate,
    ProjectRead,
    SceneAssetDetail,
    SceneAssetRead,
    SceneAssetRenderRequest,
)
from app.storage import save_upload


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(
    title=settings.app_name,
    version="0.5.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount(
    "/artifacts",
    StaticFiles(directory=settings.artifact_dir),
    name="artifacts",
)
app.mount(
    "/examples",
    StaticFiles(directory=WORKSPACE_ROOT / "example"),
    name="examples",
)

SessionDep = Annotated[Session, Depends(get_session)]


@app.get("/health")
def health() -> dict:
    enhancement = enhancement_capability()
    return {
        "status": "ok",
        "service": settings.app_name,
        "version": "0.5.0",
        "blenderEnabled": settings.blender_enabled,
        "floorplanAiConfigured": bool(settings.floorplan_ai_endpoint),
        "floorplanVision": {
            "configured": settings.floorplan_vision_configured,
            "provider": settings.floorplan_vision_provider,
            "model": settings.kuyao_vision_model,
        },
        "floorplanEnhancement": enhancement,
    }


@app.post(
    f"{settings.api_prefix}/projects",
    response_model=ProjectRead,
    status_code=status.HTTP_201_CREATED,
)
def create_project(payload: ProjectCreate, session: SessionDep) -> Project:
    project = Project(name=payload.name, description=payload.description)
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


@app.get(f"{settings.api_prefix}/projects", response_model=list[ProjectRead])
def list_projects(session: SessionDep) -> list[Project]:
    return list(session.scalars(select(Project).order_by(Project.created_at.desc())))


@app.get(f"{settings.api_prefix}/assets", response_model=list[SceneAssetRead])
def list_scene_assets(
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    generation_mode: Annotated[
        str | None,
        Query(alias="generationMode", min_length=1, max_length=32),
    ] = None,
    module_key: Annotated[
        str | None,
        Query(
            alias="moduleKey",
            pattern="^(floorplan|layout|white_model|effect_render|material_replacement)$",
        ),
    ] = None,
) -> list[dict]:
    backfill_scene_assets(session)
    statement = select(SceneAsset).where(
        SceneAsset.owner_id == LOCAL_OWNER_ID,
        SceneAsset.thumbnail_url.is_not(None),
    )
    if generation_mode:
        statement = statement.where(SceneAsset.generation_mode == generation_mode)
    assets = list(session.scalars(statement.order_by(SceneAsset.created_at.desc())))
    values = [scene_asset_read(asset) for asset in assets]
    if module_key:
        values = [value for value in values if value["module_key"] == module_key]
    return values[offset : offset + limit]


@app.get(
    f"{settings.api_prefix}/assets/modules",
    response_model=list[AssetModuleRead],
)
def list_asset_modules() -> list[dict[str, str]]:
    return asset_modules()


@app.get(
    f"{settings.api_prefix}/assets/{{asset_id}}",
    response_model=SceneAssetDetail,
)
def get_scene_asset(asset_id: str, session: SessionDep) -> dict:
    backfill_scene_assets(session)
    asset = get_local_scene_asset(session, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    return scene_asset_detail(session, asset)


@app.post(
    f"{settings.api_prefix}/assets/{{asset_id}}/renders",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def render_scene_asset_variant(
    asset_id: str,
    payload: SceneAssetRenderRequest,
    background_tasks: BackgroundTasks,
    session: SessionDep,
) -> Job:
    backfill_scene_assets(session)
    asset = get_local_scene_asset(session, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    if asset.generation_mode != "structured_3d":
        raise HTTPException(status_code=409, detail="AI 直出资产不支持三维派生渲染")
    source_job = session.get(Job, asset.job_id)
    if source_job is None or source_job.type != "FLOORPLAN_SCENE":
        raise HTTPException(status_code=409, detail="资产缺少可重建的三维场景任务")

    scene_payload = deepcopy(source_job.payload)
    scene_payload["generation_mode"] = "structured_3d"
    scene_payload["render_quality"] = payload.render_quality
    scene_payload["use_blender"] = True
    scene_payload["asset_parent_id"] = asset.id
    scene_payload["asset_module_key"] = scene_asset_read(asset)["module_key"]
    scene_payload["asset_variant_type"] = payload.variant_type
    if payload.variant_type == "camera":
        scene_payload["camera_preset_id"] = payload.camera_preset_id
        camera_names = {
            "corner_01": "右前角",
            "corner_02": "左前角",
            "eye_level_01": "1.6 米平视",
        }
        variant_name = f"机位 · {camera_names[payload.camera_preset_id]}"
    else:
        scene_payload["style_preset_id"] = payload.style_preset_id
        style_names = {
            "modern_warm_v1": "现代暖调",
            "modern_minimal_v1": "现代极简",
            "natural_wood_v1": "自然原木",
        }
        variant_name = f"材质 · {style_names[payload.style_preset_id]}"
    scene_payload["asset_title"] = f"{asset.title} · {variant_name}"[:160]

    job = create_job(
        session,
        job_type="FLOORPLAN_SCENE",
        payload=scene_payload,
        project_id=asset.project_id,
        parent_job_id=source_job.id,
    )
    background_tasks.add_task(run_job, job.id)
    return job


@app.post(
    f"{settings.api_prefix}/floorplans/analyze",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def analyze_floorplan(
    background_tasks: BackgroundTasks,
    session: SessionDep,
    source_image: UploadFile = File(...),
    plan_width_mm: int | None = Form(None, ge=2400, le=30000),
    plan_depth_mm: int | None = Form(None, ge=2400, le=30000),
    project_id: str | None = Form(None),
) -> Job:
    source = await save_upload(source_image)
    payload = {
        "source_path": str(source),
        "plan_width_mm": plan_width_mm,
        "plan_depth_mm": plan_depth_mm,
    }
    job = create_job(
        session,
        job_type="FLOORPLAN_ANALYZE",
        payload=payload,
        project_id=project_id,
    )
    background_tasks.add_task(run_job, job.id)
    return job


@app.post(
    f"{settings.api_prefix}/floorplan-scenes",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_floorplan_scene(
    payload: FloorplanSceneRequest,
    background_tasks: BackgroundTasks,
    session: SessionDep,
) -> Job:
    job = create_job(
        session,
        job_type="FLOORPLAN_SCENE",
        payload=payload.model_dump(),
        project_id=payload.project_id,
    )
    background_tasks.add_task(run_job, job.id)
    return job


@app.post(
    f"{settings.api_prefix}/layouts",
    include_in_schema=False,
)
def retired_layout_solver() -> None:
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="规则求解已下线，请使用 /v1/layouts/ai",
    )


@app.post(
    f"{settings.api_prefix}/layouts/ai",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_ai_layout_job(
    background_tasks: BackgroundTasks,
    session: SessionDep,
    source_image: UploadFile | None = File(None),
    room_type: Literal[
        "whole_home",
        "living_room",
        "dining_room",
        "bedroom",
    ] = Form("whole_home"),
    width_mm: int = Form(8150, ge=2400, le=30000),
    depth_mm: int = Form(6060, ge=2400, le=30000),
    count: int = Form(1, ge=1, le=2),
    design_prompt: str = Form("", max_length=500),
    template_ids: str | None = Form(None),
    project_id: str | None = Form(None),
) -> Job:
    try:
        selected_template_ids = resolve_ai_layout_template_ids(template_ids)
    except ProcessorError as exc:
        raise HTTPException(status_code=422, detail=exc.message) from exc
    source = await save_upload(source_image) if source_image is not None else None
    payload = {
        "source_path": str(source) if source is not None else None,
        "room_type": room_type,
        "width_mm": width_mm,
        "depth_mm": depth_mm,
        "count": count,
        "design_prompt": design_prompt.strip(),
        "template_ids": selected_template_ids,
    }
    job = create_job(
        session,
        job_type="LAYOUT_AI",
        payload=payload,
        project_id=project_id,
    )
    background_tasks.add_task(run_job, job.id)
    return job


@app.post(
    f"{settings.api_prefix}/white-model-renders",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_white_model_job(
    background_tasks: BackgroundTasks,
    session: SessionDep,
    source_image: UploadFile = File(...),
    room_type: str = Form("living_room"),
    style_preset_id: str = Form("modern_minimal_v1"),
    prompt: str = Form("", max_length=500),
    generation_mode: Literal["ai_quick", "local_preview"] = Form("ai_quick"),
    style_references: list[UploadFile] | None = File(None),
    project_id: str | None = Form(None),
) -> Job:
    references = style_references or []
    if len(references) > 3:
        raise HTTPException(status_code=422, detail="风格参考图最多上传 3 张")
    source = await save_upload(source_image)
    reference_paths = [await save_upload(reference) for reference in references]
    payload = {
        "source_path": str(source),
        "room_type": room_type,
        "style_preset_id": style_preset_id,
        "prompt": prompt.strip(),
        "generation_mode": generation_mode,
        "style_reference_paths": [str(path) for path in reference_paths],
    }
    job = create_job(
        session,
        job_type="WHITE_MODEL_RENDER",
        payload=payload,
        project_id=project_id,
    )
    background_tasks.add_task(run_job, job.id)
    return job


@app.get(
    f"{settings.api_prefix}/scenes/camera-presets",
    response_model=list[CameraPreset],
)
def camera_presets() -> list[CameraPreset]:
    return [
        CameraPreset(
            id="corner_01",
            name="右前角",
            description="从房间右前角朝中心观察",
        ),
        CameraPreset(
            id="corner_02",
            name="左前角",
            description="从房间左前角朝中心观察",
        ),
        CameraPreset(
            id="eye_level_01",
            name="平视",
            description="1.6 米平视安全机位",
        ),
    ]


@app.post(
    f"{settings.api_prefix}/effect-renders",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_effect_render_job(
    payload: EffectRenderRequest,
    background_tasks: BackgroundTasks,
    session: SessionDep,
) -> Job:
    job = create_job(
        session,
        job_type="EFFECT_RENDER",
        payload=payload.model_dump(),
        project_id=payload.project_id,
    )
    background_tasks.add_task(run_job, job.id)
    return job


@app.post(
    f"{settings.api_prefix}/material-replacement-renders",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_material_job(
    background_tasks: BackgroundTasks,
    session: SessionDep,
    source_image: UploadFile = File(...),
    wall_mask: UploadFile | None = File(None),
    floor_mask: UploadFile | None = File(None),
    wall_style: Literal[
        "warm_gray",
        "ivory",
        "sage",
        "clay",
        "microcement_cream",
        "travertine_beige",
    ] = Form("warm_gray"),
    floor_style: Literal[
        "oak_light",
        "oak_natural",
        "walnut",
        "stone_gray",
        "terrazzo_light",
    ] = Form("oak_light"),
    project_id: str | None = Form(None),
) -> Job:
    source = await save_upload(source_image)
    wall_path = await save_upload(wall_mask) if wall_mask else None
    floor_path = await save_upload(floor_mask) if floor_mask else None
    payload = {
        "source_path": str(source),
        "wall_mask_path": str(wall_path) if wall_path else None,
        "floor_mask_path": str(floor_path) if floor_path else None,
        "wall_style": wall_style,
        "floor_style": floor_style,
    }
    job = create_job(
        session,
        job_type="MATERIAL_REPLACEMENT",
        payload=payload,
        project_id=project_id,
    )
    background_tasks.add_task(run_job, job.id)
    return job


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}", response_model=JobRead)
def get_job(job_id: str, session: SessionDep) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    return job


@app.post(
    f"{settings.api_prefix}/jobs/{{job_id}}/retry",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def retry_job(
    job_id: str,
    background_tasks: BackgroundTasks,
    session: SessionDep,
) -> Job:
    original = session.get(Job, job_id)
    if original is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if original.type == "LAYOUT":
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="规则求解已下线，历史任务不可重试；请使用 /v1/layouts/ai",
        )
    job = create_job(
        session,
        job_type=original.type,
        payload=original.payload,
        project_id=original.project_id,
        parent_job_id=original.id,
    )
    background_tasks.add_task(run_job, job.id)
    return job


@app.post(f"{settings.api_prefix}/jobs/{{job_id}}/cancel", response_model=JobRead)
def cancel_job(job_id: str, session: SessionDep) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if job.status in {"SUCCEEDED", "FAILED"}:
        raise HTTPException(status_code=409, detail="任务已经结束，不能取消")
    job.status = "CANCELED"
    session.commit()
    session.refresh(job)
    return job
