from __future__ import annotations

from typing import Any, Callable

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import Job
from app.processors.common import ProcessorError
from app.processors.image import (
    run_effect_render,
    run_material_replace,
    run_white_model,
)
from app.processors.layout import run_layout


Processor = Callable[[dict[str, Any]], dict[str, Any]]
PROCESSORS: dict[str, Processor] = {
    "LAYOUT": run_layout,
    "WHITE_MODEL_RENDER": run_white_model,
    "EFFECT_RENDER": run_effect_render,
    "MATERIAL_REPLACEMENT": run_material_replace,
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
        job.result = processor(job.payload)
        job.status = "SUCCEEDED"
        job.error_code = None
        job.error_message = None
        session.commit()
    except ProcessorError as exc:
        if "job" in locals() and job is not None:
            job.status = "FAILED"
            job.error_code = exc.code
            job.error_message = exc.message
            session.commit()
    except Exception as exc:  # pragma: no cover - defensive task boundary
        if "job" in locals() and job is not None:
            job.status = "FAILED"
            job.error_code = "GENERATION_FAILED"
            job.error_message = str(exc)
            session.commit()
    finally:
        session.close()

