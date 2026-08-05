from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from app.assets import ensure_scene_asset
from app.canvas import canvas_node_id
from app.config import settings
from app.database import SessionLocal, init_db
from app.jobs import create_job
from app.main import app

# 本文件不依赖其他测试的执行顺序：自行确保测试库建表 + 轻量迁移
init_db()


def _layout_semantic() -> dict[str, Any]:
    return {
        "version": "0.5",
        "plan": {"widthMm": 8100, "depthMm": 6000},
        "validation": {"status": "human_confirmed", "humanConfirmed": True},
        "rooms": [
            {
                "id": "room_living",
                "name": "客厅",
                "type": "living_room",
                "rect": {"xMm": 0, "yMm": 0, "widthMm": 8100, "depthMm": 6000},
            }
        ],
        "walls": [{"id": "wall_1"}],
        "openings": [{"id": "door_1"}],
        "furniture": [{"id": "legacy_sofa", "roomId": "room_living"}],
    }


def _workflow_semantic() -> dict[str, Any]:
    value = _layout_semantic()
    value["validation"] = {"status": "approved_layout", "humanConfirmed": True}
    value["furniture"] = []
    return value


def _artifact(name: str) -> tuple[str, str]:
    path = settings.artifact_dir / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(f"resume:{name}".encode())
    return str(path), f"/artifacts/{name}"


def _create_asset(
    *,
    project_id: str,
    job_type: str,
    semantic: dict[str, Any] | None,
    output_name: str,
    variant_id: str,
    parent_asset_id: str | None = None,
    approved_layout_path: str | None = None,
    approved_layout_version_id: str | None = None,
    approved_color_plan_path: str | None = None,
    space_id: str | None = None,
) -> str:
    output_path, output_url = _artifact(output_name)
    del output_path
    if job_type == "LAYOUT_AI":
        payload: dict[str, Any] = {
            "room_type": "whole_home",
            "semantic_layout": semantic,
            "stage01_analysis_job_id": "job_stage01_resume",
            "stage01_approved_version_id": "job_stage01_resume:approved",
            "stage01_source_sha256": "a" * 64,
        }
        result: dict[str, Any] = {
            "generationMode": "ai_image",
            "layouts": [{"layoutId": variant_id, "previewUrl": output_url}],
            "approvalStatus": "review_required",
            "stage01Lineage": {
                "analysisJobId": "job_stage01_resume",
                "approvedVersionId": "job_stage01_resume:approved",
                "sourceSha256": "a" * 64,
            },
        }
    else:
        stage_by_type = {
            "AI_COLOR_PLAN": "color_plan",
            "AI_AXONOMETRIC": "axonometric",
            "AI_SPACE_RENDER": "space_render",
            "AI_STYLE_SCHEME": "style_scheme",
            "AI_TONE_SCHEME": "tone_scheme",
            "AI_LOCAL_EDIT": "local_edit",
        }
        stage = stage_by_type[job_type]
        payload = {
            "asset_module_key": "ai_workflow",
            "asset_parent_id": parent_asset_id,
            "workflow_stage": stage,
            "variant_group_id": f"group_{stage}",
            "semantic_layout": semantic,
        }
        if approved_layout_path:
            payload["approved_layout_path"] = approved_layout_path
        if approved_layout_version_id:
            payload["approved_layout_version_id"] = approved_layout_version_id
        if approved_color_plan_path:
            payload["approved_color_plan_path"] = approved_color_plan_path
        if space_id:
            payload["space_id"] = space_id
            payload["source_space_path"] = str(settings.artifact_dir / "resume-source.png")
        output: dict[str, Any] = {
            "variantId": variant_id,
            "variantGroupId": f"group_{stage}",
            "status": "succeeded",
            "url": output_url,
        }
        if space_id:
            output.update({"spaceId": space_id, "spaceName": "客厅"})
        result = {
            "workflowStage": stage,
            "variantGroupId": f"group_{stage}",
            "generationMode": "ai_image",
            "outputs": [output],
            "approvalStatus": "review_required",
            "spaceId": space_id,
        }

    with SessionLocal() as session:
        job = create_job(
            session,
            job_type=job_type,
            payload=payload,
            project_id=project_id,
        )
        job.status = "SUCCEEDED"
        job.progress = 1.0
        job.result = result
        session.flush()
        asset = ensure_scene_asset(session, job)
        assert asset is not None
        session.commit()
        return asset.id


def _approve(client: TestClient, asset_id: str, variant_id: str) -> dict[str, Any]:
    response = client.post(
        f"/v1/assets/{asset_id}/approve",
        json={"variantId": variant_id},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_workflow_resume_returns_path_free_stage_02_to_08_bundles() -> None:
    workflow_semantic = _workflow_semantic()
    with TestClient(app) as client:
        project_id = client.post(
            "/v1/projects",
            json={"name": "工作流历史续接"},
        ).json()["id"]
        layout_path, layout_url = _artifact("resume-layout.png")
        layout_id = _create_asset(
            project_id=project_id,
            job_type="LAYOUT_AI",
            semantic=_layout_semantic(),
            output_name="resume-layout.png",
            variant_id="layout_approved",
        )
        layout = _approve(client, layout_id, "layout_approved")
        layout_version = layout["metadata"]["approvedVersionId"]

        color_path, color_url = _artifact("resume-color.png")
        color_id = _create_asset(
            project_id=project_id,
            job_type="AI_COLOR_PLAN",
            semantic=workflow_semantic,
            output_name="resume-color.png",
            variant_id="simple_2d",
            parent_asset_id=layout_id,
            approved_layout_path=layout_path,
            approved_layout_version_id=layout_version,
        )
        color = _approve(client, color_id, "simple_2d")

        axis_id = _create_asset(
            project_id=project_id,
            job_type="AI_AXONOMETRIC",
            semantic=workflow_semantic,
            output_name="resume-axis.png",
            variant_id="isometric_day",
            parent_asset_id=color_id,
            approved_layout_path=layout_path,
            approved_layout_version_id=layout_version,
            approved_color_plan_path=color_path,
        )
        _approve(client, axis_id, "isometric_day")

        space_id = _create_asset(
            project_id=project_id,
            job_type="AI_SPACE_RENDER",
            semantic=workflow_semantic,
            output_name="resume-space.png",
            variant_id="space_room_living",
            parent_asset_id=axis_id,
            approved_layout_path=layout_path,
            approved_layout_version_id=layout_version,
            approved_color_plan_path=color_path,
            space_id="room_living",
        )
        _approve(client, space_id, "space_room_living")

        style_id = _create_asset(
            project_id=project_id,
            job_type="AI_STYLE_SCHEME",
            semantic=workflow_semantic,
            output_name="resume-style.png",
            variant_id="style_modern_minimal",
            parent_asset_id=space_id,
            space_id="room_living",
        )
        _approve(client, style_id, "style_modern_minimal")

        tone_id = _create_asset(
            project_id=project_id,
            job_type="AI_TONE_SCHEME",
            semantic=workflow_semantic,
            output_name="resume-tone.png",
            variant_id="tone_warm_gold_day",
            parent_asset_id=style_id,
            space_id="room_living",
        )
        _approve(client, tone_id, "tone_warm_gold_day")

        edit_id = _create_asset(
            project_id=project_id,
            job_type="AI_LOCAL_EDIT",
            semantic=workflow_semantic,
            output_name="resume-edit.png",
            variant_id="local_edit",
            parent_asset_id=tone_id,
            space_id="room_living",
        )
        _approve(client, edit_id, "local_edit")

        cases = [
            (layout_id, "layout", ["color_plan"]),
            (color_id, "color_plan", ["axonometric", "space_render"]),
            (axis_id, "axonometric", ["space_render"]),
            (space_id, "space_render", ["style_scheme"]),
            (style_id, "style_scheme", ["tone_scheme"]),
            (tone_id, "tone_scheme", ["local_edit"]),
            (edit_id, "local_edit", []),
        ]
        bundles: dict[str, dict[str, Any]] = {}
        for asset_id, stage, eligible in cases:
            response = client.get(f"/v1/assets/{asset_id}/workflow-resume")
            assert response.status_code == 200, response.text
            bundle = response.json()
            bundles[stage] = bundle
            assert bundle["workflowStage"] == stage
            assert bundle["eligibleNextStages"] == eligible
            assert bundle["projectId"] == project_id
            assert bundle["semanticLayout"] == (
                _layout_semantic() if stage == "layout" else workflow_semantic
            )
            serialized = json.dumps(bundle, ensure_ascii=False)
            assert "/private/" not in serialized
            assert '"/tmp/' not in serialized

        assert bundles["layout"]["approvedOutputUrl"] == layout_url
        assert bundles["layout"]["approvedLayoutAssetId"] == layout_id
        assert bundles["layout"]["approvedLayoutVersionId"] == layout_version
        assert bundles["layout"]["approvedLayoutImageUrl"] == layout_url
        assert bundles["layout"]["lineage"]["stage01"]["analysisJobId"] == ("job_stage01_resume")

        assert bundles["color_plan"]["approvedLayoutAssetId"] == layout_id
        assert bundles["color_plan"]["approvedLayoutVersionId"] == layout_version
        assert bundles["color_plan"]["approvedLayoutImageUrl"] == layout_url
        assert bundles["color_plan"]["approvedColorPlanAssetId"] == color_id
        assert bundles["color_plan"]["approvedColorPlanImageUrl"] == color_url
        assert bundles["color_plan"]["approvedOutputSha256"]

        assert bundles["axonometric"]["approvedColorPlanAssetId"] == color_id
        assert (
            bundles["axonometric"]["approvedColorPlanVersionId"]
            == (color["metadata"]["approvedVersionId"])
        )
        assert bundles["space_render"]["sourceSpaceImageUrl"] == ("/artifacts/resume-space.png")
        assert bundles["space_render"]["spaceId"] == "room_living"
        assert bundles["space_render"]["spaceName"] == "客厅"
        assert bundles["local_edit"]["lineage"]["ancestorAssetIds"] == [
            layout_id,
            color_id,
            axis_id,
            space_id,
            style_id,
            tone_id,
        ]


def test_workflow_resume_rejects_missing_unapproved_and_incomplete_assets() -> None:
    with TestClient(app) as client:
        missing = client.get("/v1/assets/asset_missing/workflow-resume")
        assert missing.status_code == 404

        project_id = client.post(
            "/v1/projects",
            json={"name": "不可续接资产"},
        ).json()["id"]
        unapproved_id = _create_asset(
            project_id=project_id,
            job_type="LAYOUT_AI",
            semantic=_layout_semantic(),
            output_name="resume-unapproved.png",
            variant_id="layout_unapproved",
        )
        unapproved = client.get(f"/v1/assets/{unapproved_id}/workflow-resume")
        assert unapproved.status_code == 409
        assert "尚未审批" in unapproved.json()["detail"]

        no_semantic_id = _create_asset(
            project_id=project_id,
            job_type="LAYOUT_AI",
            semantic=None,
            output_name="resume-no-semantic.png",
            variant_id="layout_no_semantic",
        )
        _approve(client, no_semantic_id, "layout_no_semantic")
        no_semantic = client.get(f"/v1/assets/{no_semantic_id}/workflow-resume")
        assert no_semantic.status_code == 409
        assert "SemanticLayout" in no_semantic.json()["detail"]


def test_workflow_resume_rejects_semantic_drift_inside_ai_workflow_chain() -> None:
    with TestClient(app) as client:
        project_id = client.post(
            "/v1/projects",
            json={"name": "语义漂移校验"},
        ).json()["id"]
        layout_path, _ = _artifact("resume-drift-layout.png")
        layout_id = _create_asset(
            project_id=project_id,
            job_type="LAYOUT_AI",
            semantic=_layout_semantic(),
            output_name="resume-drift-layout.png",
            variant_id="layout_drift",
        )
        layout = _approve(client, layout_id, "layout_drift")
        color_path, _ = _artifact("resume-drift-color.png")
        color_id = _create_asset(
            project_id=project_id,
            job_type="AI_COLOR_PLAN",
            semantic=_workflow_semantic(),
            output_name="resume-drift-color.png",
            variant_id="simple_2d",
            parent_asset_id=layout_id,
            approved_layout_path=layout_path,
            approved_layout_version_id=layout["metadata"]["approvedVersionId"],
        )
        _approve(client, color_id, "simple_2d")

        drifted = _workflow_semantic()
        drifted["rooms"][0]["name"] = "被篡改空间"
        axis_id = _create_asset(
            project_id=project_id,
            job_type="AI_AXONOMETRIC",
            semantic=drifted,
            output_name="resume-drift-axis.png",
            variant_id="isometric_day",
            parent_asset_id=color_id,
            approved_layout_path=layout_path,
            approved_layout_version_id=layout["metadata"]["approvedVersionId"],
            approved_color_plan_path=color_path,
        )
        _approve(client, axis_id, "isometric_day")
        response = client.get(f"/v1/assets/{axis_id}/workflow-resume")
        assert response.status_code == 409
        assert "SemanticLayout 版本不一致" in response.json()["detail"]


def test_workflow_resume_chain_is_visible_on_canvas_graph() -> None:
    """W0-e：续接链资产在 canvas-graph 中按谱系展开；SceneAsset 不可因画布软删消失。"""
    workflow_semantic = _workflow_semantic()
    with TestClient(app) as client:
        project_id = client.post(
            "/v1/projects",
            json={"name": "续接画布可见性"},
        ).json()["id"]
        layout_path, _ = _artifact("resume-graph-layout.png")
        layout_id = _create_asset(
            project_id=project_id,
            job_type="LAYOUT_AI",
            semantic=_layout_semantic(),
            output_name="resume-graph-layout.png",
            variant_id="layout_graph",
        )
        layout = _approve(client, layout_id, "layout_graph")
        layout_version = layout["metadata"]["approvedVersionId"]
        color_path, _ = _artifact("resume-graph-color.png")
        color_id = _create_asset(
            project_id=project_id,
            job_type="AI_COLOR_PLAN",
            semantic=workflow_semantic,
            output_name="resume-graph-color.png",
            variant_id="simple_2d",
            parent_asset_id=layout_id,
            approved_layout_path=layout_path,
            approved_layout_version_id=layout_version,
        )
        _approve(client, color_id, "simple_2d")
        axis_id = _create_asset(
            project_id=project_id,
            job_type="AI_AXONOMETRIC",
            semantic=workflow_semantic,
            output_name="resume-graph-axis.png",
            variant_id="isometric_day",
            parent_asset_id=color_id,
            approved_layout_path=layout_path,
            approved_layout_version_id=layout_version,
            approved_color_plan_path=color_path,
        )
        _approve(client, axis_id, "isometric_day")

        graph = client.get(f"/v1/projects/{project_id}/canvas-graph")
        assert graph.status_code == 200
        body = graph.json()
        node_ids = {node["id"] for node in body["nodes"]}
        assert canvas_node_id(layout_id, "layout_graph") in node_ids
        assert canvas_node_id(color_id, "simple_2d") in node_ids
        assert canvas_node_id(axis_id, "isometric_day") in node_ids
        edge_pairs = {
            (edge["sourceAssetId"], edge["targetAssetId"]) for edge in body["edges"]
        }
        assert (layout_id, color_id) in edge_pairs
        assert (color_id, axis_id) in edge_pairs

        # W0-d：canvas_nodes 软删不影响 SceneAsset / workflow-resume
        canvas = client.post(
            "/v1/canvases",
            json={"projectId": project_id, "name": "主画布"},
        )
        assert canvas.status_code == 201, canvas.text
        canvas_id = canvas.json()["id"]
        node = client.post(
            f"/v1/canvases/{canvas_id}/nodes",
            json={
                "canvasId": canvas_id,
                "assetId": color_id,
                "variantId": "simple_2d",
                "x": 10,
                "y": 20,
                "w": 240,
                "h": 180,
            },
        )
        assert node.status_code == 201, node.text
        node_id = node.json()["id"]
        deleted = client.delete(f"/v1/canvases/{canvas_id}/nodes/{node_id}")
        assert deleted.status_code == 200

        resume = client.get(f"/v1/assets/{color_id}/workflow-resume")
        assert resume.status_code == 200, resume.text
        assert resume.json()["workflowStage"] == "color_plan"
        asset = client.get(f"/v1/assets/{color_id}")
        assert asset.status_code == 200
        assert asset.json()["id"] == color_id
