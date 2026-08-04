#!/usr/bin/env python3
"""W0-b 历史数据回填脚本：补 FLOORPLAN_ANALYZE 资产 + LAYOUT_AI parent_asset_id。

可重复执行。对已绿数据无副作用。
"""

from __future__ import annotations

import sys
from pathlib import Path

# 将项目根加入路径，允许从任意目录执行
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.assets import backfill_scene_assets, ensure_scene_asset
from app.database import SessionLocal
from app.models import Job, SceneAsset
from sqlalchemy import select


def backfill_w0b() -> dict[str, int]:
    session = SessionLocal()
    try:
        # 1. 触发标准 backfill（FLOORPLAN_ANALYZE 现在已在 ASSET_JOB_TYPES 中）
        count = backfill_scene_assets(session)
        print(f"backfill_scene_assets: created/updated {count} assets")

        # 2. 为存量 LAYOUT_AI job 补 asset_parent_id（如果缺失且能解析）
        layout_jobs = list(
            session.scalars(
                select(Job).where(
                    Job.type == "LAYOUT_AI",
                    Job.status == "SUCCEEDED",
                )
            )
        )
        fixed_parents = 0
        for job in layout_jobs:
            payload = job.payload if isinstance(job.payload, dict) else {}
            if payload.get("asset_parent_id"):
                continue
            analysis_job_id = payload.get("stage01_analysis_job_id")
            if not isinstance(analysis_job_id, str) or not analysis_job_id:
                continue
            analysis_asset = session.scalar(
                select(SceneAsset).where(SceneAsset.job_id == analysis_job_id)
            )
            if analysis_asset is None:
                continue
            payload = dict(payload)
            payload["asset_parent_id"] = analysis_asset.id
            job.payload = payload
            # 同步更新已有资产的 parent_asset_id
            asset = session.scalar(
                select(SceneAsset).where(SceneAsset.job_id == job.id)
            )
            if asset is not None and asset.parent_asset_id != analysis_asset.id:
                asset.parent_asset_id = analysis_asset.id
            fixed_parents += 1
        if fixed_parents:
            session.commit()
            print(f"fixed {fixed_parents} LAYOUT_AI parent_asset_id")

        # 3. 报告 03/04/05 中 asset_parent_id 仍为空的 job（需要人工处理）
        orphan_workflow_jobs = list(
            session.scalars(
                select(Job).where(
                    Job.type.in_(
                        {
                            "AI_COLOR_PLAN",
                            "AI_AXONOMETRIC",
                            "AI_SPACE_RENDER",
                        }
                    ),
                    Job.status == "SUCCEEDED",
                )
            )
        )
        orphans = 0
        for job in orphan_workflow_jobs:
            payload = job.payload if isinstance(job.payload, dict) else {}
            if not payload.get("asset_parent_id"):
                orphans += 1
        if orphans:
            print(f"WARNING: {orphans} workflow jobs (03/04/05) still lack asset_parent_id")

        return {
            "backfilled": count,
            "fixed_parents": fixed_parents,
            "orphan_workflow_jobs": orphans,
        }
    finally:
        session.close()


if __name__ == "__main__":
    result = backfill_w0b()
    print(result)
