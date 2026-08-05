"""变体并发扇出与增量发布（优化计划 A1 / B1）。

原本只存在于 ai_workflow.py，导致阶段 02（layout.py）被漏掉、继续串行且
无增量发布。抽到公共模块后两边共用同一套并发上限与进度语义。

PROVIDER_SEMAPHORE 是进程级的：它约束的是所有阶段、所有任务同时在途的
provider 调用总数，而每次 fanout_generate 的 workers 只塑造单个批次的宽度。
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable

from app.config import settings


ProgressCallback = Callable[[dict[str, Any]], None]
CancelCheck = Callable[[], bool]

# 客户端限流：避免变体扇出把偶发 429 变成系统性 429。
PROVIDER_SEMAPHORE = threading.Semaphore(settings.provider_concurrency)

# 单批次扇出宽度。总在途量由上面的信号量封顶，这里只决定一批内的并行度。
FANOUT_WORKERS = 4


def fanout_generate(
    keys: list[str],
    generate_one: Callable[[str], dict[str, Any]],
    build_result: Callable[[list[dict[str, Any]]], dict[str, Any]],
    on_progress: ProgressCallback | None,
    should_cancel: CancelCheck | None = None,
) -> dict[str, Any]:
    """Run per-variant generations concurrently and publish growing outputs.

    ``generate_one`` must convert provider failures into failed output dicts
    itself. Progress payloads are forced to batchStatus="running" so the UI
    never shows a mid-batch "complete" notice; the final result keeps the real
    status. Output order always follows the input key order.

    When ``should_cancel`` reports True (B3), pending futures are cancelled and
    the partial result returns immediately; in-flight provider calls cannot be
    aborted, so their threads are detached via ``shutdown(wait=False)``.
    """

    completed: list[tuple[int, dict[str, Any]]] = []

    def ordered_outputs() -> list[dict[str, Any]]:
        return [output for _, output in sorted(completed, key=lambda item: item[0])]

    executor = ThreadPoolExecutor(
        max_workers=max(1, min(FANOUT_WORKERS, len(keys)))
    )
    canceled = False
    try:
        future_to_index = {
            executor.submit(generate_one, key): index
            for index, key in enumerate(keys)
        }
        for future in as_completed(future_to_index):
            if should_cancel is not None and should_cancel():
                canceled = True
                for pending in future_to_index:
                    pending.cancel()
                partial = build_result(ordered_outputs())
                partial["batchStatus"] = "canceled"
                return partial
            completed.append((future_to_index[future], future.result()))
            if on_progress is not None:
                partial = build_result(ordered_outputs())
                partial["batchStatus"] = "running"
                on_progress(partial)
        return build_result(ordered_outputs())
    finally:
        # 取消路径不等待在途 provider 调用；正常路径下所有 future 已完成
        executor.shutdown(wait=not canceled)
