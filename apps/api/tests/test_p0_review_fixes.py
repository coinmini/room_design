"""P0 评审修复回归：variantApprovals 保留、UTC 时间戳、跨站 CSRF。"""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.assets import ensure_scene_asset
from app.database import SessionLocal, init_db
from app.jobs import PROCESSORS, create_job, run_job
from app.main import app
from app.models import Job, SceneAsset

init_db()


def test_project_created_at_has_utc_suffix() -> None:
    client = TestClient(app)
    response = client.post("/v1/projects", json={"name": "tz-check"})
    assert response.status_code in {200, 201}, response.text
    created = response.json()["createdAt"]
    assert created.endswith("Z") or created.endswith("+00:00"), created


def test_cross_site_mutation_rejected() -> None:
    client = TestClient(app)
    response = client.post(
        "/v1/projects",
        json={"name": "csrf"},
        headers={
            "Origin": "https://evil.example",
            "Sec-Fetch-Site": "cross-site",
        },
    )
    assert response.status_code == 403


def test_variant_approvals_survive_ensure_scene_asset(
    monkeypatch,
) -> None:
    """重启/backfill 路径不得抹掉分叉变体批准。"""
    from app import jobs as jobs_mod

    def fake_processor(payload: dict) -> dict:
        return {
            "outputs": [
                {
                    "variantId": "style_modern_minimal",
                    "url": "/artifacts/s1.png",
                    "status": "succeeded",
                },
                {
                    "variantId": "style_natural_wood",
                    "url": "/artifacts/s2.png",
                    "status": "succeeded",
                },
            ],
            "previewUrl": "/artifacts/s1.png",
            "workflowStage": "style_scheme",
        }

    monkeypatch.setitem(PROCESSORS, "AI_STYLE_SCHEME", fake_processor)

    session = SessionLocal()
    try:
        job = create_job(
            session,
            job_type="AI_STYLE_SCHEME",
            payload={
                "project_id": None,
                "source_space_path": "/tmp/x.png",
                "source_space_version_id": "v1",
                "parent_approved_version_id": "v1",
                "parent_variant_id": "space_a",
                "source_sha256": "a" * 64,
                "source_approved": True,
                "semantic_layout": {"rooms": [{"id": "r1"}]},
                "space_id": "r1",
                "variant_group_id": "vg1",
                "asset_parent_id": "parent_asset",
                "variants": ["style_modern_minimal", "style_natural_wood"],
            },
            project_id=None,
        )
        job_id = job.id
        # mark succeeded with result for ensure_scene_asset
        job.status = "SUCCEEDED"
        job.result = fake_processor({})
        session.commit()
        asset = ensure_scene_asset(session, job)
        assert asset is not None
        asset_id = asset.id
        meta = dict(asset.metadata_json or {})
        meta["approvalStatus"] = "approved"
        meta["approvedVariantId"] = "style_modern_minimal"
        meta["approvedVersionId"] = f"{asset_id}:style_modern_minimal"
        meta["variantApprovals"] = {
            "style_modern_minimal": {
                "versionId": f"{asset_id}:style_modern_minimal",
                "approvedAt": "2026-01-01T00:00:00Z",
            },
            "style_natural_wood": {
                "versionId": f"{asset_id}:style_natural_wood",
                "approvedAt": "2026-01-01T00:00:00Z",
            },
        }
        asset.metadata_json = meta
        session.commit()

        # 再次 ensure（模拟 backfill/重启）
        job2 = session.get(Job, job_id)
        assert job2 is not None
        again = ensure_scene_asset(session, job2)
        assert again is not None
        kept = (again.metadata_json or {}).get("variantApprovals") or {}
        assert "style_modern_minimal" in kept
        assert "style_natural_wood" in kept
        assert (again.metadata_json or {}).get("approvalStatus") == "approved"
    finally:
        session.close()
