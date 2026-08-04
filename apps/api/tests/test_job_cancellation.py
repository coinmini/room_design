from __future__ import annotations

from typing import Any

from pytest import MonkeyPatch
from sqlalchemy import select

from app.database import SessionLocal
from app.jobs import PROCESSORS, create_job, run_job
from app.models import Job, SceneAsset
from app.processors.common import ProcessorError


def _cancel_from_other_session(job_id: str) -> None:
    session = SessionLocal()
    try:
        job = session.get(Job, job_id)
        assert job is not None
        assert job.status == "RUNNING"
        job.status = "CANCELED"
        session.commit()
    finally:
        session.close()


def _new_white_model_job() -> str:
    session = SessionLocal()
    try:
        job = create_job(
            session,
            job_type="WHITE_MODEL_RENDER",
            payload={"source_path": "/tmp/cancellation-race.png"},
        )
        return job.id
    finally:
        session.close()


def _assert_canceled_without_asset(job_id: str) -> None:
    session = SessionLocal()
    try:
        job = session.get(Job, job_id)
        assert job is not None
        assert job.status == "CANCELED"
        assert job.result is None
        assert job.error_code is None
        assert job.error_message is None
        assert (
            session.scalar(select(SceneAsset).where(SceneAsset.job_id == job_id)) is None
        )
    finally:
        session.close()


def test_provider_result_does_not_revive_or_archive_canceled_job(
    monkeypatch: MonkeyPatch,
) -> None:
    holder: dict[str, str] = {}

    def cancel_then_return(_payload: dict[str, Any]) -> dict[str, Any]:
        _cancel_from_other_session(holder["job_id"])
        return {
            "generationMode": "ai_quick",
            "outputs": [{"url": "/artifacts/late-provider-result.png"}],
        }

    monkeypatch.setitem(PROCESSORS, "WHITE_MODEL_RENDER", cancel_then_return)
    job_id = _new_white_model_job()
    holder["job_id"] = job_id
    run_job(job_id)
    _assert_canceled_without_asset(job_id)


def test_provider_error_does_not_overwrite_canceled_job(
    monkeypatch: MonkeyPatch,
) -> None:
    holder: dict[str, str] = {}

    def cancel_then_fail(_payload: dict[str, Any]) -> dict[str, Any]:
        _cancel_from_other_session(holder["job_id"])
        raise ProcessorError("LATE_PROVIDER_ERROR", "late provider error")

    monkeypatch.setitem(PROCESSORS, "WHITE_MODEL_RENDER", cancel_then_fail)
    job_id = _new_white_model_job()
    holder["job_id"] = job_id
    run_job(job_id)
    _assert_canceled_without_asset(job_id)
