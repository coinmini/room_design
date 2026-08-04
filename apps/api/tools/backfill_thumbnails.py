#!/usr/bin/env python3
"""W0-c: Backfill webp thumbnails for existing scene assets.

Run: cd apps/api && python tools/backfill_thumbnails.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Add parent to path so app imports work when run from tools/
repo_root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(repo_root / "apps" / "api"))

from app.assets import backfill_thumbnails  # noqa: E402
from app.database import SessionLocal, init_db  # noqa: E402


def main() -> None:
    init_db()
    session = SessionLocal()
    try:
        count = backfill_thumbnails(session)
        print(f"backfilled {count} thumbnails")
    finally:
        session.close()


if __name__ == "__main__":
    main()
