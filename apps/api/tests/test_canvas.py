"""W0-e：逐图展开器（app/canvas.py）与项目画布图谱端点测试。"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.canvas import build_project_canvas_graph, canvas_node_id, expand_asset_variants
from app.assets import ensure_scene_asset
from app.database import SessionLocal, init_db
from app.jobs import create_job
from app.main import app
from app.models import Job, Project, SceneAsset

# 本文件不依赖其他测试的执行顺序：自行确保测试库建表 + 轻量迁移
from app.models import Job, Project, SceneAsset
from app.canvas import build_project_canvas_graph, canvas_node_id, expand_asset_variants, partial_node_id

# 本文件不依赖其他测试的执行顺序：自行确保测试库建表 + 轻量迁移
init_db()


def _project(project_id: str = "project_canvas_test") -> str:
    with SessionLocal() as session:
        if session.get(Project, project_id) is None:
            session.add(Project(id=project_id, name="画布测试项目"))
            session.commit()
    return project_id


def _make_asset(
    job_type: str,
    payload: dict[str, Any],
    result: dict[str, Any],
    *,
    project_id: str | None = None,
) -> SceneAsset:
    with SessionLocal() as session:
        job = create_job(
            session,
            job_type=job_type,
            payload=payload,
            project_id=project_id,
        )
        job.status = "SUCCEEDED"
        job.result = result
        session.commit()
        session.refresh(job)
        asset = ensure_scene_asset(session, job)
        session.commit()
        assert asset is not None, f"{job_type} 应产生资产"
        return asset


def test_expand_ai_workflow_outputs_into_per_image_variants() -> None:
    asset = _make_asset(
        "AI_COLOR_PLAN",
        {
            "variant_group_id": "vg-1",
            "asset_parent_id": None,
        },
        {
            "workflowStage": "color_plan",
            "variantGroupId": "vg-1",
            "outputs": [
                {"variantId": "modern_warm", "url": "/artifacts/cp-1.png", "status": "succeeded"},
                {"variantId": "modern_minimal", "url": "/artifacts/cp-2.png", "status": "succeeded"},
                {"variantId": "natural_wood", "url": "/artifacts/cp-3.png", "status": "succeeded"},
                {"variantId": "broken", "status": "failed"},
            ],
        },
    )
    variants = expand_asset_variants(asset)
    assert [v["variantId"] for v in variants] == [
        "modern_warm",
        "modern_minimal",
        "natural_wood",
    ]
    assert all(v["status"] == "succeeded" for v in variants)
    assert all(v["approved"] is False for v in variants)
    assert all(v["assetId"] == asset.id for v in variants)

    # 审批状态反映在变体上
    with SessionLocal() as session:
        current = session.get(SceneAsset, asset.id)
        metadata = dict(current.metadata_json)
        metadata["approvalStatus"] = "approved"
        metadata["approvedVariantId"] = "modern_minimal"
        metadata["approvedVersionId"] = "ver-9"
        current.metadata_json = metadata
        session.commit()
        session.refresh(current)
        variants = expand_asset_variants(current)
    flags = {v["variantId"]: (v["approved"], v["approvedVersionId"]) for v in variants}
    assert flags["modern_minimal"] == (True, "ver-9")
    assert flags["modern_warm"] == (False, None)


def test_expand_layout_uses_structured_pairs_and_legacy_fallback() -> None:
    # 新数据：layoutVariants 结构化配对
    asset = _make_asset(
        "LAYOUT_AI",
        {"source_path": "/tmp/x.png"},
        {
            "layouts": [
                {"layoutId": "layout-a", "previewUrl": "/artifacts/la.png"},
                {"layoutId": "layout-b", "previewUrl": "/artifacts/lb.png"},
            ]
        },
    )
    assert asset.deliverables.get("layoutVariants") == [
        {"layoutId": "layout-a", "previewUrl": "/artifacts/la.png"},
        {"layoutId": "layout-b", "previewUrl": "/artifacts/lb.png"},
    ]
    variants = expand_asset_variants(asset)
    assert [(v["variantId"], v["url"]) for v in variants] == [
        ("layout-a", "/artifacts/la.png"),
        ("layout-b", "/artifacts/lb.png"),
    ]

    # 旧数据回退：无 layoutVariants，只有 previewUrls + metadata.variantIds
    with SessionLocal() as session:
        current = session.get(SceneAsset, asset.id)
        deliverables = dict(current.deliverables)
        deliverables.pop("layoutVariants")
        current.deliverables = deliverables
        session.commit()
        session.refresh(current)
        variants = expand_asset_variants(current)
    assert [(v["variantId"], v["url"]) for v in variants] == [
        ("layout-a", "/artifacts/la.png"),
        ("layout-b", "/artifacts/lb.png"),
    ]


def test_expand_floorplan_analyze_is_single_analysis_node() -> None:
    asset = _make_asset(
        "FLOORPLAN_ANALYZE",
        {"source_path": "/tmp/floorplan.png"},
        {
            "sourceImageUrl": "/artifacts/fp-src.png",
            "overlayPreviewUrl": "/artifacts/fp-overlay.png",
            "semanticLayout": {"rooms": []},
        },
    )
    variants = expand_asset_variants(asset)
    assert len(variants) == 1
    assert variants[0]["variantId"] == "analysis"
    assert variants[0]["url"] == "/artifacts/fp-overlay.png"


def test_expand_white_model_pairs_output_urls_with_variant_ids() -> None:
    asset = _make_asset(
        "WHITE_MODEL_RENDER",
        {"source_path": "/tmp/room.png"},
        {
            "outputs": [
                {"variantId": "modern", "url": "/artifacts/wm-1.png"},
                {"variantId": "scandinavian", "url": "/artifacts/wm-2.png"},
            ]
        },
    )
    variants = expand_asset_variants(asset)
    assert [(v["variantId"], v["url"]) for v in variants] == [
        ("modern", "/artifacts/wm-1.png"),
        ("scandinavian", "/artifacts/wm-2.png"),
    ]


def test_expand_single_image_assets_fall_back_to_default_variant() -> None:
    asset = _make_asset(
        "EFFECT_RENDER",
        {"source_path": "/tmp/room.png"},
        {"outputUrl": "/artifacts/effect.png", "baseRenderUrl": "/artifacts/base.png"},
    )
    variants = expand_asset_variants(asset)
    assert len(variants) == 1
    assert variants[0]["variantId"] == "default"
    assert variants[0]["url"] == "/artifacts/effect.png"


def test_get_job_lazily_heals_missing_asset_id() -> None:
    """C3+C4 竞态：SUCCEEDED 先于归档可见时，GET /v1/jobs/{id} 惰性补归档。"""
    with SessionLocal() as session:
        job = create_job(
            session,
            job_type="FLOORPLAN_ANALYZE",
            payload={"source_path": "/tmp/floorplan.png"},
        )
        job.status = "SUCCEEDED"
        # 模拟竞态窗口：已有终态结果，但 assetId 尚未由归档事务写入
        job.result = {
            "sourceImageUrl": "/artifacts/fp-src.png",
            "overlayPreviewUrl": "/artifacts/fp-overlay.png",
            "semanticLayout": {"rooms": []},
        }
        session.commit()
        job_id = job.id

    with TestClient(app) as client:
        response = client.get(f"/v1/jobs/{job_id}")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "SUCCEEDED"
        assert body["result"]["assetId"]

    with SessionLocal() as session:
        asset = session.scalar(select(SceneAsset).where(SceneAsset.job_id == job_id))
        assert asset is not None


def test_canvas_graph_nodes_edges_and_endpoint() -> None:
    project_id = _project()
    parent = _make_asset(
        "AI_COLOR_PLAN",
        {"variant_group_id": "vg-p"},
        {
            "workflowStage": "color_plan",
            "outputs": [
                {"variantId": "warm", "url": "/artifacts/p-1.png", "status": "succeeded"},
            ],
        },
        project_id=project_id,
    )
    child = _make_asset(
        "AI_STYLE_SCHEME",
        {
            "variant_group_id": "vg-c",
            "asset_parent_id": parent.id,
            "parent_variant_id": "warm",
        },
        {
            "workflowStage": "style_scheme",
            "outputs": [
                {"variantId": "wabi_sabi", "url": "/artifacts/c-1.png", "status": "succeeded"},
                {"variantId": "industrial", "url": "/artifacts/c-2.png", "status": "succeeded"},
            ],
        },
        project_id=project_id,
    )

    with SessionLocal() as session:
        graph = build_project_canvas_graph(session, project_id)
    node_ids = {node["id"] for node in graph["nodes"]}
    assert canvas_node_id(parent.id, "warm") in node_ids
    assert canvas_node_id(child.id, "wabi_sabi") in node_ids
    assert canvas_node_id(child.id, "industrial") in node_ids
    edge = next(e for e in graph["edges"] if e["targetAssetId"] == child.id)
    assert edge["sourceAssetId"] == parent.id
    assert edge["sourceVariantId"] == "warm"
    child_nodes = [n for n in graph["nodes"] if n["assetId"] == child.id]
    assert all(n["workflowStage"] == "style_scheme" for n in child_nodes)
    assert all(n["parentVariantId"] == "warm" for n in child_nodes)

    with TestClient(app) as client:
        response = client.get(f"/v1/projects/{project_id}/canvas-graph")
        assert response.status_code == 200
        body = response.json()
        assert body["projectId"] == project_id
        assert body["nodeCount"] == len(body["nodes"])
        assert {e["id"] for e in body["edges"]} >= {f"{parent.id}->{child.id}"}



def _make_cancelled_job_with_partial_outputs(
    job_type: str,
    payload: dict[str, Any],
    result: dict[str, Any],
    *,
    project_id: str | None = None,
) -> str:
    """Create a cancelled job that has partial outputs in result. Returns job_id."""
    with SessionLocal() as session:
        job = create_job(
            session,
            job_type=job_type,
            payload=payload,
            project_id=project_id,
        )
        job.status = "CANCELED"
        job.result = result
        session.commit()
        return job.id


def test_cancelled_job_partial_outputs_appear_as_temporary_nodes() -> None:
    """W0-f：取消 job 的 partial outputs 作为临时节点出现在画布图谱中。"""
    project_id = _project("project_partial_test")
    # 先建一个成功资产作为父节点
    parent = _make_asset(
        "AI_COLOR_PLAN",
        {"variant_group_id": "vg-parent"},
        {
            "workflowStage": "color_plan",
            "outputs": [
                {"variantId": "warm", "url": "/artifacts/parent.png", "status": "succeeded"},
            ],
        },
        project_id=project_id,
    )
    # 再建一个取消 job，带 partial outputs
    cancelled_job_id = _make_cancelled_job_with_partial_outputs(
        "AI_STYLE_SCHEME",
        {
            "variant_group_id": "vg-cancelled",
            "asset_parent_id": parent.id,
            "parent_variant_id": "warm",
        },
        {
            "workflowStage": "style_scheme",
            "batchStatus": "canceled",
            "outputs": [
                {"variantId": "wabi_sabi", "url": "/artifacts/c-1.png", "status": "succeeded"},
                {"variantId": "industrial", "url": "/artifacts/c-2.png", "status": "succeeded"},
            ],
        },
        project_id=project_id,
    )

    with SessionLocal() as session:
        graph = build_project_canvas_graph(session, project_id)

    # 应包含成功资产节点 + 2 个临时节点
    node_ids = {node["id"] for node in graph["nodes"]}
    assert canvas_node_id(parent.id, "warm") in node_ids
    from app.canvas import partial_node_id
    assert partial_node_id(cancelled_job_id, "wabi_sabi") in node_ids
    assert partial_node_id(cancelled_job_id, "industrial") in node_ids

    # 临时节点标记
    temp_nodes = [n for n in graph["nodes"] if n.get("isTemporary")]
    assert len(temp_nodes) == 2
    for node in temp_nodes:
        assert node["jobStatus"] == "CANCELED"
        assert node["approved"] is False
        assert node["status"] == "partial"
        assert node["assetType"] == "partial_output"

    # 端点验证
    with TestClient(app) as client:
        response = client.get(f"/v1/projects/{project_id}/canvas-graph")
        assert response.status_code == 200
        body = response.json()
        assert body["partialJobCount"] == 1
        assert body["nodeCount"] == 3  # 1 成功 + 2 临时


def test_failed_job_partial_outputs_appear_as_temporary_nodes() -> None:
    """W0-f：失败 job 的 partial outputs 也作为临时节点出现。"""
    project_id = _project("project_failed_test")
    failed_job_id = _make_cancelled_job_with_partial_outputs(
        "WHITE_MODEL_RENDER",
        {"source_path": "/tmp/room.png"},
        {
            "outputs": [
                {"variantId": "modern", "url": "/artifacts/wm-1.png"},
            ],
            "error": "partial failure",
        },
        project_id=project_id,
    )
    # 把状态改成 FAILED（_make_cancelled_job_with_partial_outputs 默认 CANCELED）
    with SessionLocal() as session:
        job = session.get(Job, failed_job_id)
        job.status = "FAILED"
        session.commit()

    with SessionLocal() as session:
        graph = build_project_canvas_graph(session, project_id)

    from app.canvas import partial_node_id
    assert partial_node_id(failed_job_id, "modern") in {n["id"] for n in graph["nodes"]}
    temp_node = next(n for n in graph["nodes"] if n.get("isTemporary"))
    assert temp_node["jobStatus"] == "FAILED"


def test_cancelled_job_without_outputs_does_not_create_nodes() -> None:
    """W0-f：取消 job 若无任何输出，不应产生临时节点。"""
    project_id = _project("project_empty_cancel_test")
    _make_cancelled_job_with_partial_outputs(
        "AI_COLOR_PLAN",
        {"variant_group_id": "vg-empty"},
        {"batchStatus": "canceled", "outputs": []},
        project_id=project_id,
    )

    with SessionLocal() as session:
        graph = build_project_canvas_graph(session, project_id)

    assert all(not n.get("isTemporary") for n in graph["nodes"])
    assert graph["partialJobCount"] == 1  # job 被计数
    assert graph["nodeCount"] == 0
