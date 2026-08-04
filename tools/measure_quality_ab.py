"""A5 实测：kuyao 图像生成 quality=medium vs high 的耗时对照。

用法（在 apps/api 目录下运行）：
    .venv/bin/python ../../tools/measure_quality_ab.py medium
    .venv/bin/python ../../tools/measure_quality_ab.py high

每次调用真实 provider 生成 1 张图，打印 elapsedSeconds。
源图使用一张真实已批准布局图，size 用生产代码 _target_size 的同一逻辑得出。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

API_ROOT = Path(__file__).resolve().parents[1] / "apps" / "api"
sys.path.insert(0, str(API_ROOT))

from app.config import settings  # noqa: E402
from app.processors.ai_workflow import _target_size  # noqa: E402
from app.processors.kuyao_image_edit import edit_floorplan_image  # noqa: E402

SOURCE = (
    Path(__file__).resolve().parents[1]
    / ".local"
    / "artifacts"
    / "approved-layout-asset_2be56027cde74890-layout_ai-19c610d8a2.png"
)

PROMPT = (
    "Generate one presentation-ready full-home color floor plan rendering. "
    "INPUT ROLE LOCK: image 1 is the user-approved layout and the sole visual geometry "
    "authority. Preserve its complete outer contour, orientation, room count, room boundaries, "
    "walls, door and window positions, circulation, furniture categories, furniture count and "
    "furniture placement. Do not mirror, rotate, crop, stretch, merge or invent rooms. "
    "Render warm wood flooring in living areas, light tile in wet areas, neutral walls, "
    "clear furniture color coding, soft shadows, top-down orthographic view, no text labels. "
    "Additional design requirement: restrained contemporary residential design with practical, "
    "buildable details."
)


def main() -> None:
    quality = sys.argv[1] if len(sys.argv) > 1 else "medium"
    size = _target_size(SOURCE)
    result = edit_floorplan_image(
        SOURCE,
        api_key=settings.floorplan_vision_api_key,
        base_url=settings.kuyao_base_url,
        prompt=PROMPT,
        model=settings.kuyao_image_model,
        size=size,
        quality=quality,
        timeout_seconds=settings.kuyao_image_timeout_seconds,
    )
    print(
        json.dumps(
            {
                "requestedQuality": quality,
                "quality": result["quality"],
                "size": result["size"],
                "model": result["model"],
                "bytes": result["bytes"],
                "elapsedSeconds": result["elapsedSeconds"],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
