"""C5：建任务幂等键——重复提交返回既有 job，不创建第二个批次。

附带 C4 验证：dispatch_job 通过独立线程池执行 run_job。
"""

from __future__ import annotations

import uuid
from time import monotonic, sleep

from fastapi.testclient import TestClient
from pytest import MonkeyPatch
from sqlalchemy import select

from app.database import SessionLocal, init_db
from app.jobs import PROCESSORS, create_job, dispatch_job
from app.main import app
from app.models import Job

# 本文件不依赖其他测试的执行顺序：自行确保测试库建表 + 轻量迁移
init_db()


def _count_jobs_with_key(key: str) -> int:
    with SessionLocal() as session:
        return len(
            session.scalars(select(Job).where(Job.idempotency_key == key)).all()
        )


def test_same_idempotency_key_returns_existing_job() -> None:
    key = f"idem-{uuid.uuid4()}"
    with SessionLocal() as session:
        first = create_job(
            session,
            job_type="FLOORPLAN_ANALYZE",
            payload={"n": 1},
            idempotency_key=key,
        )
        second = create_job(
            session,
            job_type="FLOORPLAN_ANALYZE",
            payload={"n": 1},
            idempotency_key=key,
        )
        assert second.id == first.id
    assert _count_jobs_with_key(key) == 1


def test_blank_or_missing_key_always_creates_new_job() -> None:
    with SessionLocal() as session:
        without_key = create_job(session, job_type="FLOORPLAN_ANALYZE", payload={})
        blank_key = create_job(
            session,
            job_type="FLOORPLAN_ANALYZE",
            payload={},
            idempotency_key="   ",
        )
        assert without_key.id != blank_key.id
        assert without_key.idempotency_key is None
        assert blank_key.idempotency_key is None


def test_different_keys_create_different_jobs() -> None:
    with SessionLocal() as session:
        first = create_job(
            session,
            job_type="FLOORPLAN_ANALYZE",
            payload={},
            idempotency_key=f"idem-{uuid.uuid4()}",
        )
        second = create_job(
            session,
            job_type="FLOORPLAN_ANALYZE",
            payload={},
            idempotency_key=f"idem-{uuid.uuid4()}",
        )
        assert first.id != second.id


def test_retry_endpoint_deduplicates_by_idempotency_key_header() -> None:
    with SessionLocal() as session:
        original = create_job(
            session,
            job_type="FLOORPLAN_ANALYZE",
            payload={"source_path": "/nonexistent.png"},
        )
        original.status = "FAILED"
        session.commit()
        original_id = original.id

    key = f"idem-{uuid.uuid4()}"
    with TestClient(app) as client:
        first = client.post(
            f"/v1/jobs/{original_id}/retry",
            headers={"Idempotency-Key": key},
        )
        second = client.post(
            f"/v1/jobs/{original_id}/retry",
            headers={"Idempotency-Key": key},
        )
        assert first.status_code == 202
        assert second.status_code == 202
        assert first.json()["id"] == second.json()["id"]
        assert first.json()["id"] != original_id
    assert _count_jobs_with_key(key) == 1


def test_dispatch_job_runs_via_executor(monkeypatch: MonkeyPatch) -> None:
    """C4：dispatch_job 提交到独立线程池，run_job 在线程中完成终态写入。"""

    def fake_processor(payload: dict) -> dict:
        return {"echo": payload}

    monkeypatch.setitem(PROCESSORS, "FLOORPLAN_ANALYZE", fake_processor)
    with SessionLocal() as session:
        job = create_job(
            session,
            job_type="FLOORPLAN_ANALYZE",
            payload={"hello": "executor"},
        )
        job_id = job.id

    dispatch_job(job_id)

    deadline = monotonic() + 15
    status = ""
    while monotonic() < deadline:
        with SessionLocal() as session:
            current = session.get(Job, job_id)
            status = current.status if current else ""
            if status in {"SUCCEEDED", "FAILED", "CANCELED"}:
                result = current.result if current else None
                break
        sleep(0.1)
    assert status == "SUCCEEDED"
    assert result == {"echo": {"hello": "executor"}}
