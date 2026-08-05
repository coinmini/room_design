from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from time import perf_counter
from typing import Any, Callable

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
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


logger = logging.getLogger(__name__)

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

# C4：独立作业线程池——不再与 anyio 的进程级 CapacityLimiter(40) 共享令牌，
# 避免轮询/健康检查/取消等同步路由与作业线程互相挤占（无背压的悬崖）。
# 一个 job 无论多少变体都只占一个线程；超出 max_workers 的任务排队等待（背压）。
# worker 是 daemon 线程（CPython ≥3.9），进程退出时不阻塞；
# 被中断的 RUNNING 任务由 C1 reclaim_stale_jobs 在下次启动时回收。
_JOB_EXECUTOR_MAX_WORKERS = 8
_executor_lock = threading.Lock()
_job_executor: ThreadPoolExecutor | None = None


def _executor() -> ThreadPoolExecutor:
    """懒创建 + 关闭后可重建（测试会多次进出 lifespan）。"""
    global _job_executor
    with _executor_lock:
        if _job_executor is None:
            _job_executor = ThreadPoolExecutor(
                max_workers=_JOB_EXECUTOR_MAX_WORKERS,
                thread_name_prefix="job-worker",
            )
        return _job_executor


def dispatch_job(job_id: str) -> None:
    """C4：全部建任务入口的统一分发点；将来迁移队列系统只需改这一个函数。"""
    _executor().submit(run_job, job_id)


def shutdown_job_executor() -> None:
    """有界关闭：排队中的任务取消（DB 中保持 QUEUED，下次启动由 C1 回收并提示重试），
    运行中的任务随 daemon 线程在进程退出时中断，同样由 C1 回收。"""
    global _job_executor
    with _executor_lock:
        if _job_executor is not None:
            _job_executor.shutdown(wait=False, cancel_futures=True)
            _job_executor = None


def create_job(
    session: Session,
    *,
    job_type: str,
    payload: dict[str, Any],
    project_id: str | None = None,
    parent_job_id: str | None = None,
    idempotency_key: str | None = None,
) -> Job:
    # C5：携带幂等键时，重复提交返回既有 job——前端 xhrRequest 的网络自动重试
    # 会复用同一个键，丢失的响应不会再静默启动第二个完整批次。
    key = (idempotency_key or "").strip() or None
    if key is not None:
        existing = session.scalar(select(Job).where(Job.idempotency_key == key))
        if existing is not None:
            logger.info(
                "idempotent resubmit: returning existing job %s (%s) for key %s",
                existing.id,
                existing.type,
                key,
            )
            return existing
    job = Job(
        type=job_type,
        payload=payload,
        project_id=project_id,
        parent_job_id=parent_job_id,
        idempotency_key=key,
    )
    session.add(job)
    try:
        session.commit()
    except IntegrityError:
        # 并发重复提交撞上唯一约束：回滚后返回先到的那个 job
        session.rollback()
        if key is None:
            raise
        existing = session.scalar(select(Job).where(Job.idempotency_key == key))
        if existing is None:
            raise
        return existing
    session.refresh(job)
    return job


def reclaim_stale_jobs() -> int:
    """把上一个进程遗留的 QUEUED/RUNNING 任务标记为 WORKER_LOST（C1）。

    ⚠️ 仅在单进程部署下安全。任何迁往 `uvicorn --workers N` 的动作之前，
    必须先用环境变量开关或 per-process owner 列加以限制。
    """
    with SessionLocal() as session:
        count = session.execute(
            update(Job)
            .where(Job.status.in_(["QUEUED", "RUNNING"]))
            .values(
                status="FAILED",
                error_code="WORKER_LOST",
                error_message="服务重启导致任务中断，请点击重试重新生成。",
            )
        ).rowcount
        session.commit()
    count = int(count or 0)
    if count:
        logger.warning("reclaimed %s stale jobs as WORKER_LOST", count)
    return count


def archive_job_asset(job_id: str) -> None:
    """终态结果提交后，在独立事务里归档资产（C3）。

    归档失败不再摧毁已付费的生成结果；`backfill_scene_assets` 可补偿。
    """
    try:
        with SessionLocal() as session:
            job = session.get(Job, job_id)
            if job is None or job.status != "SUCCEEDED":
                return
            asset = ensure_scene_asset(session, job)
            if asset is not None:
                # SQLAlchemy JSON 列不检测嵌套变更，必须整体重新赋值
                job.result = {**(job.result or {}), "assetId": asset.id}
            session.commit()
    except Exception:
        logger.exception(
            "job %s asset archival failed; run backfill_scene_assets to compensate",
            job_id,
        )


def run_job(job_id: str) -> None:
    started = perf_counter()
    succeeded = False
    session = SessionLocal()
    try:
        job = session.get(Job, job_id)
        if job is None or job.status == "CANCELED":
            return
        job.status = "RUNNING"
        job.started_at = datetime.now(UTC)
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
                logger.debug("job %s progress publish failed", job_id, exc_info=True)

        def should_cancel() -> bool:
            """B3：短会话检查取消状态，供并发扇出在变体间隙及时停止。"""
            try:
                with SessionLocal() as cs:
                    current = cs.get(Job, job_id)
                    return current is None or current.status == "CANCELED"
            except Exception:
                return False

        if processor in PROGRESS_PROCESSORS:
            processor_result = processor(
                job.payload,
                on_progress=publish_progress,
                should_cancel=should_cancel,
            )
        else:
            processor_result = processor(job.payload)
        # Cancellation may be committed by another request while the provider is running.
        # Refresh before persisting provider output so a late result cannot revive the job.
        session.expire(job)
        session.refresh(job)
        if job.status == "CANCELED":
            # B3：取消不再丢弃已生成内容——保留取消前完成的全部输出
            if processor_result:
                job.result = {**processor_result, "batchStatus": "canceled"}
                job.finished_at = datetime.now(UTC)
                session.commit()
            logger.info("job %s (%s) canceled during provider run", job_id, job.type)
            return
        job.result = processor_result
        job.status = "SUCCEEDED"
        job.error_code = None
        job.error_message = None
        job.finished_at = datetime.now(UTC)
        # C3：先提交已付费的生成结果，资产归档移入独立事务
        session.commit()
        succeeded = True
        logger.info(
            "job %s (%s) succeeded in %.1fs",
            job_id,
            job.type,
            perf_counter() - started,
        )
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
            job.finished_at = datetime.now(UTC)
            session.commit()
            logger.warning(
                "job %s (%s) failed with %s in %.1fs: %s",
                job_id,
                job.type,
                exc.code,
                perf_counter() - started,
                exc.message,
            )
    except Exception as exc:  # pragma: no cover - defensive task boundary
        # C2：保留完整 traceback，之前 traceback 被完全销毁
        logger.exception(
            "job %s crashed after %.1fs", job_id, perf_counter() - started
        )
        if "job" in locals() and job is not None:
            session.rollback()
            session.expire_all()
            job = session.get(Job, job_id)
            if job is None or job.status == "CANCELED":
                return
            job.status = "FAILED"
            job.error_code = "GENERATION_FAILED"
            job.error_message = str(exc)
            job.finished_at = datetime.now(UTC)
            session.commit()
    finally:
        session.close()
    if succeeded:
        archive_job_asset(job_id)
