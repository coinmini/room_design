from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_session, init_db
from app.jobs import create_job, run_job
from app.models import Job, Project
from app.schemas import (
    CameraPreset,
    EffectRenderRequest,
    JobRead,
    LayoutRequest,
    ProjectCreate,
    ProjectRead,
)
from app.storage import save_upload


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
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

SessionDep = Annotated[Session, Depends(get_session)]


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": settings.app_name,
        "version": "0.1.0",
        "blenderEnabled": settings.blender_enabled,
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


@app.post(
    f"{settings.api_prefix}/layouts",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_layout_job(
    payload: LayoutRequest,
    background_tasks: BackgroundTasks,
    session: SessionDep,
) -> Job:
    job = create_job(
        session,
        job_type="LAYOUT",
        payload=payload.model_dump(),
        project_id=payload.project_id,
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
    prompt: str = Form(""),
    project_id: str | None = Form(None),
) -> Job:
    source = await save_upload(source_image)
    payload = {
        "source_path": str(source),
        "room_type": room_type,
        "style_preset_id": style_preset_id,
        "prompt": prompt[:100],
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
    wall_style: str = Form("warm_gray"),
    floor_style: str = Form("oak_light"),
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

