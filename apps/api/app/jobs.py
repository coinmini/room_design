from __future__ import annotations

from typing import Any, Callable

from sqlalchemy.orm import Session

from app.assets import ensure_scene_asset
from app.database import SessionLocal
from app.models import Job
from app.processors.ai_workflow import (
    run_ai_axonometric,
    run_ai_color_plan,
    run_ai_local_edit,
    run_ai_space_render,
    run_ai_style_scheme,
    run_ai_tone_scheme,
)
from app.processors.common import ProcessorError
from app.processors.image import (
    run_effect_render,
    run_material_replace,
    run_white_model,
)
from app.processors.floorplan import (
    run_floorplan_analyze,
    run_floorplan_scene,
)
from app.processors.layout import run_ai_layout


Processor = Callable[[dict[str, Any]], dict[str, Any]]
PROCESSORS: dict[str, Processor] = {
    "FLOORPLAN_ANALYZE": run_floorplan_analyze,
    "FLOORPLAN_SCENE": run_floorplan_scene,
    "LAYOUT_AI": run_ai_layout,
    "WHITE_MODEL_RENDER": run_white_model,
    "EFFECT_RENDER": run_effect_render,
    "MATERIAL_REPLACEMENT": run_material_replace,
    "AI_COLOR_PLAN": run_ai_color_plan,
    "AI_AXONOMETRIC": run_ai_axonometric,
    "AI_SPACE_RENDER": run_ai_space_render,
    "AI_STYLE_SCHEME": run_ai_style_scheme,
    "AI_TONE_SCHEME": run_ai_tone_scheme,
    "AI_LOCAL_EDIT": run_ai_local_edit,
}

# 多变体批次处理器（A1）：支持运行中增量回写部分结果
PROGRESS_PROCESSORS = {
    run_ai_color_plan,
    run_ai_axonometric,
    run_ai_space_render,
    run_ai_style_scheme,
    run_ai_tone_scheme,
}


def create_job(
    session: Session,
    *,
    job_type: str,
    payload: dict[str, Any],
    project_id: str | None = None,
    parent_job_id: str | None = None,
) -> Job:
    job = Job(
        type=job_type,
        payload=payload,
        project_id=project_id,
        parent_job_id=parent_job_id,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def run_job(job_id: str) -> None:
    session = SessionLocal()
    try:
        job = session.get(Job, job_id)
        if job is None or job.status == "CANCELED":
            return
        job.status = "RUNNING"
        session.commit()
        processor = PROCESSORS[job.type]

        def publish_progress(partial: dict[str, Any]) -> None:
            """best-effort 部分结果回写；终态写入决定最终结果，失败不影响主流程。"""
            try:
                with SessionLocal() as ps:
                    pj = ps.get(Job, job_id)
                    if pj is None or pj.status != "RUNNING":
                        return
                    # SQLAlchemy JSON 列不检测嵌套变更，必须整体重新赋值
                    pj.result = {**partial, "batchStatus": "running"}
                    ps.commit()
            except Exception:
                pass

        if processor in PROGRESS_PROCESSORS:
            processor_result = processor(job.payload, on_progress=publish_progress)
        else:
            processor_result = processor(job.payload)
        # Cancellation may be committed by another request while the provider is running.
        # Refresh before persisting provider output so a late result cannot revive the job.
        session.expire(job)
        session.refresh(job)
        if job.status == "CANCELED":
            return
        job.result = processor_result
        job.status = "SUCCEEDED"
        job.error_code = None
        job.error_message = None
        session.flush()
        asset = ensure_scene_asset(session, job)
        if asset is not None:
            # SQLAlchemy JSON columns do not detect nested mutation. Reassign a fresh mapping.
            job.result = {**(job.result or {}), "assetId": asset.id}
        session.commit()
    except ProcessorError as exc:
        if "job" in locals() and job is not None:
            session.rollback()
            session.expire_all()
            job = session.get(Job, job_id)
            if job is None or job.status == "CANCELED":
                return
            job.status = "FAILED"
            job.result = exc.partial_result
            job.error_code = exc.code
            job.error_message = exc.message
            session.commit()
    except Exception as exc:  # pragma: no cover - defensive task boundary
        if "job" in locals() and job is not None:
            session.rollback()
            session.expire_all()
            job = session.get(Job, job_id)
            if job is None or job.status == "CANCELED":
                return
            job.status = "FAILED"
            job.error_code = "GENERATION_FAILED"
            job.error_message = str(exc)
            session.commit()
    finally:
        session.close()
