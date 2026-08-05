"""应用日志：保证 root INFO 有 asctime/level/name，不被 uvicorn 默认配置吞掉。"""

from __future__ import annotations

import logging


def configure_logging(level: int = logging.INFO) -> None:
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    else:
        root.setLevel(level)
        for handler in root.handlers:
            handler.setLevel(level)
            if not handler.formatter:
                handler.setFormatter(
                    logging.Formatter(
                        "%(asctime)s %(levelname)s [%(name)s] %(message)s",
                        datefmt="%Y-%m-%d %H:%M:%S",
                    )
                )
