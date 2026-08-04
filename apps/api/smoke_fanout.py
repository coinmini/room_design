"""批 2 (A1) 并发扇出 + 增量进度冒烟脚本。

用假的 _generate（sleep 2 秒）替换真实 provider，验证：
1. 3 个变体并发执行：总耗时约 2 秒而非 6 秒；
2. on_progress 回调被调用 3 次，每次 outputs 数量递增且带 batchStatus=running；
3. 部分失败时单变体失败不影响其余变体。
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.processors import ai_workflow  # noqa: E402


def _make_payload(tmp: Path) -> dict:
    # 复用仓库已有的真实 PNG 资产，避免手写 PNG 字节
    source = tmp / "source.png"
    source.write_bytes(
        (Path("../../.local/artifacts/upload-62c6f0955b.png")).read_bytes()
    )
    return {
        "variant_group_id": "vg_smoke",
        "source_approved": True,
        "source_space_path": str(source),
        "space_id": "living_room",
        "variants": ["warm_gold_day", "neutral_dusk", "cool_blue_night"],
        "semantic_layout": {
            "rooms": [{"id": "living_room", "type": "living", "label": "客厅"}]
        },
    }


def main() -> None:
    tmp = Path(".local/smoke_fanout")
    tmp.mkdir(parents=True, exist_ok=True)
    payload = _make_payload(tmp)

    progress_log: list[tuple[float, int, str]] = []

    def fake_generate(**kwargs):
        variant = kwargs["prompt"].split("Apply: ")[-1][:20]
        # 第二个变体模拟失败
        if "neutral dusk" in kwargs["prompt"]:
            time.sleep(1)
            from app.processors.common import ProcessorError

            raise ProcessorError("PROVIDER_UNAVAILABLE", "模拟的供应商故障")
        time.sleep(2)
        out = tmp / f"out_{abs(hash(variant)) % 99999}.png"
        out.write_bytes(b"png")
        return {
            "url": f"/artifacts/{out.name}",
            "provider": "mock",
            "model": "mock-model",
            "size": "1024x1024",
            "quality": "high",
        }

    start = time.monotonic()
    with patch.object(ai_workflow, "_generate", side_effect=fake_generate), patch.object(
        ai_workflow, "_require_provider", lambda: None
    ):
        result = ai_workflow.run_ai_tone_scheme(
            payload,
            on_progress=lambda partial: progress_log.append(
                (
                    round(time.monotonic() - start, 2),
                    len(partial["outputs"]),
                    partial["batchStatus"],
                )
            ),
        )
    elapsed = time.monotonic() - start

    print(f"总耗时: {elapsed:.2f}s（串行应 ≥5s，并发应 ≈2s）")
    print(f"进度回调: {progress_log}")
    statuses = [(o["variantId"], o["status"]) for o in result["outputs"]]
    print(f"最终输出: {statuses}")
    assert elapsed < 4.5, f"并发失败：耗时 {elapsed:.2f}s"
    assert len(progress_log) == 3, f"回调次数错误：{len(progress_log)}"
    assert all(bs == "running" for _, _, bs in progress_log)
    assert [n for _, n, _ in progress_log] == [1, 2, 3], "outputs 未递增"
    ok = [s for _, s in statuses].count("succeeded")
    fail = [s for _, s in statuses].count("failed")
    assert ok == 2 and fail == 1, f"部分失败处理错误：{statuses}"
    assert result["batchStatus"] == "partial", f"batchStatus 错误：{result['batchStatus']}"
    print("✅ 并发扇出 + 增量进度 + 部分失败隔离 全部通过")


if __name__ == "__main__":
    main()
