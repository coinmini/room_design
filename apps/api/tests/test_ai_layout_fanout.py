"""阶段 02（LAYOUT_AI）的并发扇出与增量发布回归测试。

背景：优化计划 A1/B1 当初只改了 ai_workflow.py 的五个阶段，layout.py 被漏掉，
导致阶段 02 一直串行生成且全程没有部分结果——界面停在「无预览」，
两张布局的耗时是单张的两倍。
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pytest
from pytest import MonkeyPatch

from app.config import settings
from app.jobs import PROGRESS_PROCESSORS
from app.processors import layout as layout_module
from app.processors.layout import run_ai_layout


@pytest.fixture
def stage01_payload(tmp_path: Path, monkeypatch: MonkeyPatch) -> dict[str, Any]:
    monkeypatch.setattr(settings, "floorplan_final_image_provider", "auto")
    monkeypatch.setattr(settings, "kuyao_api_key", "test-only-key")
    monkeypatch.setattr(settings, "kuyao_image_model", "gpt-image-2")

    source = tmp_path / "stage01.png"
    source.write_bytes(b"stage01-bytes")
    sha = layout_module._stage01_image_sha256(source)

    # 绕过与本用例无关的控制图渲染
    monkeypatch.setattr(
        layout_module, "_stage01_control_image", lambda *a, **k: source
    )
    monkeypatch.setattr(
        layout_module, "_ai_layout_output_size", lambda *a, **k: ("1024x1024", 0, 0)
    )
    return {
        "source_path": str(source),
        "stage01_source_sha256": sha,
        # _semantic_layout_value 要求 rooms 非空，否则整份语义会被判为无效
        "semantic_layout": {
            "sourceSha256": sha,
            "rooms": [{"id": "room_living", "name": "客厅", "type": "living"}],
        },
        "room_type": "whole_home",
        "width_mm": 10000,
        "depth_mm": 8000,
        "count": 4,
    }


def _install_slow_provider(monkeypatch: MonkeyPatch, delay: float = 0.25) -> list[float]:
    """每次调用睡 delay 秒；返回各次调用的开始时间戳。"""
    starts: list[float] = []
    lock = threading.Lock()

    def fake_edit(_source: Path, **kwargs: Any) -> dict[str, Any]:
        with lock:
            starts.append(time.monotonic())
        time.sleep(delay)
        prompt = str(kwargs.get("prompt", ""))
        return {
            "url": f"/artifacts/layout-{len(prompt)}-{len(starts)}.png",
            "provider": "kuyao",
            "model": "gpt-image-2",
        }

    monkeypatch.setattr(layout_module, "edit_floorplan_image", fake_edit)
    return starts


def test_layout_is_registered_for_progress() -> None:
    # 漏注册会让 jobs.py 不传 on_progress，扇出退化成「有并发但无预览」
    assert run_ai_layout in PROGRESS_PROCESSORS


def test_layout_variants_run_concurrently(
    stage01_payload: dict[str, Any], monkeypatch: MonkeyPatch
) -> None:
    delay = 0.25
    starts = _install_slow_provider(monkeypatch, delay)

    began = time.monotonic()
    result = run_ai_layout(stage01_payload)
    elapsed = time.monotonic() - began

    assert len(result["layouts"]) == 4
    assert len(starts) == 4
    # 串行需要 4×delay；并发下总耗时应显著低于此
    assert elapsed < delay * 4 * 0.75, f"疑似仍在串行：{elapsed:.2f}s"
    # 四次调用几乎同时开始
    assert max(starts) - min(starts) < delay


def test_layout_publishes_partial_results(
    stage01_payload: dict[str, Any], monkeypatch: MonkeyPatch
) -> None:
    _install_slow_provider(monkeypatch, 0.05)
    seen: list[dict[str, Any]] = []

    result = run_ai_layout(stage01_payload, on_progress=seen.append)

    # 每完成一张发布一次，且过程中必须标 running，避免界面提前显示「已完成」
    assert [len(p["layouts"]) for p in seen] == [1, 2, 3, 4]
    assert all(p["batchStatus"] == "running" for p in seen)
    assert result.get("batchStatus") != "running"
    # 增量发布期间字段必须完整可渲染
    assert seen[0]["provider"] == "kuyao"
    assert seen[0]["notice"] == layout_module.AI_LAYOUT_NOTICE


def test_layout_output_order_follows_variant_index(
    stage01_payload: dict[str, Any], monkeypatch: MonkeyPatch
) -> None:
    # 先提交的不一定先返回；顺序必须按变体索引而不是完成顺序
    order = {0: 0.20, 1: 0.02, 2: 0.14, 3: 0.06}
    seq: list[int] = []

    def fake_edit(_source: Path, **kwargs: Any) -> dict[str, Any]:
        variant = len(seq)
        seq.append(variant)
        time.sleep(order.get(variant, 0.05))
        return {"url": "/artifacts/x.png", "provider": "kuyao", "model": "gpt-image-2"}

    monkeypatch.setattr(layout_module, "edit_floorplan_image", fake_edit)
    result = run_ai_layout(stage01_payload)

    assert [item["layoutId"] for item in result["layouts"]] == [
        "layout_ai_1",
        "layout_ai_2",
        "layout_ai_3",
        "layout_ai_4",
    ]


def test_layout_stops_early_when_canceled(
    stage01_payload: dict[str, Any], monkeypatch: MonkeyPatch
) -> None:
    _install_slow_provider(monkeypatch, 0.05)

    result = run_ai_layout(stage01_payload, should_cancel=lambda: True)

    assert result["batchStatus"] == "canceled"
    assert len(result["layouts"]) < 4
