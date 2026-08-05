from __future__ import annotations

import json
from time import monotonic, sleep
from typing import Any, Callable

import cv2
import numpy as np
from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from app.assets import ensure_scene_asset, scene_asset_read
from app.database import SessionLocal
from app.jobs import PROCESSORS, create_job
from app.main import app


def image_bytes() -> bytes:
    image = np.full((420, 720, 3), 248, dtype=np.uint8)
    cv2.rectangle(image, (35, 35), (685, 385), (32, 45, 56), 7)
    cv2.line(image, (395, 35), (395, 385), (32, 45, 56), 5)
    success, encoded = cv2.imencode(".png", image)
    assert success
    return encoded.tobytes()


def semantic_layout() -> dict[str, Any]:
    return {
        "version": "0.5",
        "profileId": "workflow_test",
        "plan": {"widthMm": 8000, "depthMm": 5000},
        "rooms": [
            {
                "id": "room_living",
                "name": "客厅",
                "type": "living_room",
                "rect": {"xMm": 0, "yMm": 0, "widthMm": 4500, "depthMm": 5000},
            },
            {
                "id": "room_bedroom",
                "name": "卧室",
                "type": "bedroom",
                "rect": {
                    "xMm": 4500,
                    "yMm": 0,
                    "widthMm": 3500,
                    "depthMm": 5000,
                },
            },
        ],
        "walls": [],
        "openings": [],
        "furniture": [],
    }


def _fake_workflow_processor(stage: str) -> Callable[[dict[str, Any]], dict[str, Any]]:
    def run(payload: dict[str, Any]) -> dict[str, Any]:
        if stage == "space_render":
            selected = payload.get("selected_space_ids") or [
                room["id"] for room in payload["semantic_layout"]["rooms"]
            ]
            outputs = [
                {
                    "variantId": f"space_{space_id}",
                    "variantGroupId": payload["variant_group_id"],
                    "spaceId": space_id,
                    "spaceName": space_id,
                    "status": "succeeded",
                    "url": f"/artifacts/space-{space_id}.png",
                    "provider": "mock-kuyao",
                    "model": "gpt-image-2",
                }
                for space_id in selected
            ]
        else:
            outputs = [
                {
                    "variantId": variant,
                    "variantGroupId": payload["variant_group_id"],
                    "status": "succeeded",
                    "url": f"/artifacts/{stage}-{variant}.png",
                    "provider": "mock-kuyao",
                    "model": "gpt-image-2",
                }
                for variant in payload["variants"]
            ]
        return {
            "workflowStage": stage,
            "variantGroupId": payload["variant_group_id"],
            "generationMode": "ai_image",
            "provider": "mock-kuyao",
            "model": "gpt-image-2",
            "promptVersion": "pure-ai-design-workflow-test",
            "approvedLayout": {
                "versionId": payload.get("approved_layout_version_id"),
                "approvalConfirmed": payload["layout_approved"],
                "sha256": "approved-layout-test-digest",
            },
            "semanticInput": {
                "profileId": payload["semantic_layout"].get("profileId"),
                "sha256": "semantic-test-digest",
            },
            "outputs": outputs,
            "count": len(outputs),
            "succeededCount": len(outputs),
            "failedCount": 0,
            "batchStatus": "complete",
            "partialOutputs": [],
            "approvalStatus": "review_required",
            "structureAudit": {
                "performed": False,
                "geometryGuaranteed": False,
                "requiresManualReview": True,
            },
            "selectedSpaceIds": [
                output["spaceId"] for output in outputs if output.get("spaceId")
            ],
            "inputRoles": {
                "image1": "approved_layout_geometry_authority",
                "semanticLayout": "geometry_and_room_semantics_authority",
            },
        }

    return run


def _create_layout_asset(project_id: str) -> dict[str, Any]:
    session = SessionLocal()
    try:
        job = create_job(
            session,
            job_type="LAYOUT_AI",
            payload={"room_type": "whole_home"},
            project_id=project_id,
        )
        job.result = {
            "generationMode": "ai_image",
            "provider": "mock-kuyao",
            "layouts": [
                {
                    "layoutId": "layout_ai_1",
                    "previewUrl": "/artifacts/approved-layout.png",
                }
            ],
            "count": 1,
            "approvalStatus": "review_required",
        }
        job.status = "SUCCEEDED"
        session.flush()
        asset = ensure_scene_asset(session, job)
        assert asset is not None
        session.commit()
        session.refresh(asset)
        return scene_asset_read(asset)
    finally:
        session.close()


def _create_floorplan_asset(project_id: str) -> dict[str, Any]:
    session = SessionLocal()
    try:
        job = create_job(
            session,
            job_type="FLOORPLAN_SCENE",
            payload={
                "source_image_url": "/artifacts/historical-floorplan-source.png",
                "generation_mode": "ai_direct",
            },
            project_id=project_id,
        )
        job.result = {
            "generationMode": "ai_direct",
            "provider": "historical-floorplan",
            "dollhouseUrl": "/artifacts/historical-floorplan.png",
        }
        job.status = "SUCCEEDED"
        session.flush()
        asset = ensure_scene_asset(session, job)
        assert asset is not None
        session.commit()
        session.refresh(asset)
        return scene_asset_read(asset)
    finally:
        session.close()


def _completed_job(client: TestClient, response) -> dict[str, Any]:
    assert response.status_code == 202, response.text
    job_id = response.json()["id"]
    # C4 后任务在独立线程池异步执行：轮询直到终态
    deadline = monotonic() + 30.0
    value: dict[str, Any] = {}
    while monotonic() < deadline:
        job = client.get(f"/v1/jobs/{job_id}")
        assert job.status_code == 200
        value = job.json()
        if value["status"] in {"SUCCEEDED", "FAILED", "CANCELED"}:
            break
        sleep(0.05)
    assert value["status"] == "SUCCEEDED", value
    return value


def _asset_for_job(client: TestClient, job_id: str) -> dict[str, Any]:
    response = client.get("/v1/assets?moduleKey=ai_workflow&limit=100")
    assert response.status_code == 200
    return next(asset for asset in response.json() if asset["jobId"] == job_id)


def test_ai_workflow_requires_explicit_layout_approval(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setitem(
        PROCESSORS,
        "AI_COLOR_PLAN",
        lambda _payload: (_ for _ in ()).throw(AssertionError("processor must not run")),
    )
    source = image_bytes()
    base_data = {
        "semantic_layout": json.dumps(semantic_layout(), ensure_ascii=False),
        "variants": "simple_2d",
    }
    with TestClient(app) as client:
        project_id = client.post("/v1/projects", json={"name": "approval test"}).json()["id"]
        floorplan_asset = _create_floorplan_asset(project_id)

        # W0-b: asset_parent_id 必填，缺失时先报 422
        missing = client.post(
            "/v1/ai-workflow/color-plans",
            files={"approved_layout_image": ("plan.png", source, "image/png")},
            data=base_data,
        )
        assert missing.status_code == 422

        rejected = client.post(
            "/v1/ai-workflow/color-plans",
            files={"approved_layout_image": ("plan.png", source, "image/png")},
            data={**base_data, "layout_approved": "false", "asset_parent_id": floorplan_asset["id"]},
        )
        # 显式 layout_approved=false → 409 业务拒绝（不再依赖 pydantic 422）
        assert rejected.status_code == 409
        assert "已批准" in rejected.json()["detail"]


def test_ai_workflow_rejects_empty_rooms_and_requires_approved_color_plan() -> None:
    source = image_bytes()
    with TestClient(app) as client:
        project_id = client.post("/v1/projects", json={"name": "empty rooms test"}).json()["id"]
        floorplan_asset = _create_floorplan_asset(project_id)

        empty_rooms = client.post(
            "/v1/ai-workflow/color-plans",
            files={"approved_layout_image": ("plan.png", source, "image/png")},
            data={
                "semantic_layout": json.dumps({"rooms": []}),
                "layout_approved": "true",
                "variants": "simple_2d",
                "asset_parent_id": floorplan_asset["id"],
            },
        )
        assert empty_rooms.status_code == 422
        assert "非空" in empty_rooms.json()["detail"]

        common = {
            "semantic_layout": json.dumps(semantic_layout(), ensure_ascii=False),
            "layout_approved": "true",
        }
        # W0-b: asset_parent_id 必填，缺失时报 422
        missing_axis_color_plan = client.post(
            "/v1/ai-workflow/axonometric-views",
            files={"approved_layout_image": ("plan.png", source, "image/png")},
            data={**common, "variants": "isometric_day"},
        )
        assert missing_axis_color_plan.status_code == 422

        missing_space_color_plan = client.post(
            "/v1/ai-workflow/space-renders",
            files={"approved_layout_image": ("plan.png", source, "image/png")},
            data={**common, "selected_space_ids": "room_living"},
        )
        assert missing_space_color_plan.status_code == 422


def test_color_plan_keeps_historical_floorplan_parent_compatibility(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setitem(
        PROCESSORS,
        "AI_COLOR_PLAN",
        _fake_workflow_processor("color_plan"),
    )
    source = image_bytes()
    with TestClient(app) as client:
        project_id = client.post(
            "/v1/projects",
            json={"name": "历史户型兼容测试"},
        ).json()["id"]
        floorplan_asset = _create_floorplan_asset(project_id)

        color_job = _completed_job(
            client,
            client.post(
                "/v1/ai-workflow/color-plans",
                files={"approved_layout_image": ("plan.png", source, "image/png")},
                data={
                    "semantic_layout": json.dumps(
                        semantic_layout(),
                        ensure_ascii=False,
                    ),
                    "layout_approved": "true",
                    "approved_layout_version_id": "historical-floorplan-v1",
                    "project_id": project_id,
                    "asset_parent_id": floorplan_asset["id"],
                    "variants": "simple_2d",
                },
            ),
        )

    assert floorplan_asset["module_key"] == "floorplan"
    assert floorplan_asset["metadata"].get("approvalStatus") is None
    assert color_job["payload"]["asset_parent_id"] == floorplan_asset["id"]


def test_ai_workflow_stages_archive_assets_without_blender_and_keep_lineage(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setitem(
        PROCESSORS,
        "AI_COLOR_PLAN",
        _fake_workflow_processor("color_plan"),
    )
    monkeypatch.setitem(
        PROCESSORS,
        "AI_AXONOMETRIC",
        _fake_workflow_processor("axonometric"),
    )
    monkeypatch.setitem(
        PROCESSORS,
        "AI_SPACE_RENDER",
        _fake_workflow_processor("space_render"),
    )
    source = image_bytes()
    semantic = semantic_layout()

    with TestClient(app) as client:
        project_id = client.post("/v1/projects", json={"name": "AI 工作流测试"}).json()["id"]
        other_project_id = client.post(
            "/v1/projects",
            json={"name": "其他项目"},
        ).json()["id"]
        layout_asset = _create_layout_asset(project_id)
        common = {
            "semantic_layout": json.dumps(
                {"semanticLayout": semantic},
                ensure_ascii=False,
            ),
            "layout_approved": "true",
            "approved_layout_version_id": "layout_ai_1",
            "project_id": project_id,
        }

        wrong_project = client.post(
            "/v1/ai-workflow/color-plans",
            files={"approved_layout_image": ("plan.png", source, "image/png")},
            data={
                **common,
                "project_id": other_project_id,
                "asset_parent_id": layout_asset["id"],
                "variants": "simple_2d",
            },
        )
        assert wrong_project.status_code == 409

        unapproved_layout_parent = client.post(
            "/v1/ai-workflow/color-plans",
            files={"approved_layout_image": ("plan.png", source, "image/png")},
            data={
                **common,
                "asset_parent_id": layout_asset["id"],
                "variants": "simple_2d",
            },
        )
        assert unapproved_layout_parent.status_code == 409
        assert "平面布局资产尚未审批" in unapproved_layout_parent.json()["detail"]

        unknown_layout_variant = client.post(
            f"/v1/assets/{layout_asset['id']}/approve",
            json={"variantId": "not-a-layout"},
        )
        assert unknown_layout_variant.status_code == 422
        assert "layoutId" in unknown_layout_variant.json()["detail"]

        approved_layout = client.post(
            f"/v1/assets/{layout_asset['id']}/approve",
            json={"variantId": "layout_ai_1", "comment": "采用第一版平面布局"},
        )
        assert approved_layout.status_code == 200, approved_layout.text
        assert approved_layout.json()["metadata"]["approvalStatus"] == "approved"
        assert approved_layout.json()["metadata"]["approvedVariantId"] == "layout_ai_1"
        assert approved_layout.json()["metadata"]["approvedAt"]
        approved_version_id = approved_layout.json()["metadata"]["approvedVersionId"]
        assert approved_version_id.startswith(
            f"{layout_asset['id']}:layout_ai_1:"
        )
        assert approved_layout.json()["deliverables"]["approvedVariantId"] == "layout_ai_1"
        assert (
            approved_layout.json()["deliverables"]["approvedVersionId"]
            == approved_version_id
        )
        assert approved_layout.json()["deliverables"]["approvedOutputUrl"] == (
            "/artifacts/approved-layout.png"
        )

        persisted_layout = client.get(f"/v1/assets/{layout_asset['id']}")
        assert persisted_layout.status_code == 200
        assert persisted_layout.json()["metadata"]["approvalStatus"] == "approved"
        assert persisted_layout.json()["metadata"]["approvedVariantId"] == "layout_ai_1"
        assert (
            persisted_layout.json()["metadata"]["approvedVersionId"]
            == approved_version_id
        )
        assert persisted_layout.json()["deliverables"]["approvedOutputUrl"] == (
            "/artifacts/approved-layout.png"
        )

        # 取消批准后回到待审；再批可继续派生
        unapproved_layout = client.post(
            f"/v1/assets/{layout_asset['id']}/unapprove",
            json={"variantId": "layout_ai_1", "comment": "改主意了"},
        )
        assert unapproved_layout.status_code == 200, unapproved_layout.text
        assert (
            unapproved_layout.json()["metadata"]["approvalStatus"]
            == "review_required"
        )
        assert "approvedVariantId" not in unapproved_layout.json()["metadata"] or (
            unapproved_layout.json()["metadata"].get("approvedVariantId") in (None, "")
        )
        # 幂等：再次取消不报错
        unapproved_again = client.post(
            f"/v1/assets/{layout_asset['id']}/unapprove",
            json={"variantId": "layout_ai_1"},
        )
        assert unapproved_again.status_code == 200
        # 重新批准以便后续彩平用例继续
        reapproved_layout = client.post(
            f"/v1/assets/{layout_asset['id']}/approve",
            json={"variantId": "layout_ai_1", "comment": "再次采用"},
        )
        assert reapproved_layout.status_code == 200
        assert reapproved_layout.json()["metadata"]["approvalStatus"] == "approved"
        approved_version_id = reapproved_layout.json()["metadata"]["approvedVersionId"]

        color_job = _completed_job(
            client,
            client.post(
                "/v1/ai-workflow/color-plans",
                files={"approved_layout_image": ("plan.png", source, "image/png")},
                data={
                    **common,
                    "asset_parent_id": layout_asset["id"],
                    "variants": '["simple_2d", "watercolor"]',
                },
            ),
        )
        assert color_job["type"] == "AI_COLOR_PLAN"
        assert color_job["payload"]["layout_approved"] is True
        assert color_job["payload"]["semantic_layout"] == semantic
        color_asset = _asset_for_job(client, color_job["id"])
        assert color_job["result"]["assetId"] == color_asset["id"]
        assert color_asset["moduleKey"] == "ai_workflow"
        assert color_asset["assetType"] == "ai_color_plan"
        assert color_asset["parentAssetId"] == layout_asset["id"]
        assert color_asset["deliverables"]["approvedLayoutImageUrl"].startswith(
            "/artifacts/"
        )
        assert color_asset["metadata"]["workflowStage"] == "color_plan"
        assert color_asset["metadata"]["approvalStatus"] == "review_required"
        assert color_asset["metadata"]["approvedLayout"]["approvalConfirmed"] is True
        color_capabilities = color_asset["deliverables"]["capabilities"]
        assert color_capabilities["editableModel"] is False
        assert color_capabilities["multiView"] is False
        assert color_capabilities["glbDelivery"] is False
        assert "blendUrl" not in color_asset["deliverables"]
        assert "glbUrl" not in color_asset["deliverables"]

        unknown_variant = client.post(
            f"/v1/assets/{color_asset['id']}/approve",
            json={"variantId": "not-a-successful-output"},
        )
        assert unknown_variant.status_code == 422

        unapproved_color_parent = client.post(
            "/v1/ai-workflow/axonometric-views",
            files=[
                ("approved_layout_image", ("plan.png", source, "image/png")),
                (
                    "approved_color_plan_image",
                    ("color.png", source, "image/png"),
                ),
            ],
            data={
                **common,
                "asset_parent_id": color_asset["id"],
                "variants": "isometric_day",
            },
        )
        assert unapproved_color_parent.status_code == 409
        assert "尚未审批" in unapproved_color_parent.json()["detail"]

        approved_color = client.post(
            f"/v1/assets/{color_asset['id']}/approve",
            json={"variantId": "simple_2d", "comment": "采用简洁彩平方案"},
        )
        assert approved_color.status_code == 200, approved_color.text
        assert approved_color.json()["metadata"]["approvalStatus"] == "approved"
        assert approved_color.json()["metadata"]["approvedVariantId"] == "simple_2d"
        assert approved_color.json()["metadata"]["approvedAt"]
        assert approved_color.json()["deliverables"]["approvedOutputUrl"].endswith(
            "color_plan-simple_2d.png"
        )
        persisted_color = client.get(f"/v1/assets/{color_asset['id']}")
        assert persisted_color.status_code == 200
        assert persisted_color.json()["metadata"]["approvalStatus"] == "approved"

        invalid_axis_parent = client.post(
            "/v1/ai-workflow/axonometric-views",
            files=[
                ("approved_layout_image", ("plan.png", source, "image/png")),
                (
                    "approved_color_plan_image",
                    ("color.png", source, "image/png"),
                ),
            ],
            data={
                **common,
                "asset_parent_id": layout_asset["id"],
                "variants": "isometric_day",
            },
        )
        assert invalid_axis_parent.status_code == 409

        axis_job = _completed_job(
            client,
            client.post(
                "/v1/ai-workflow/axonometric-views",
                files=[
                    ("approved_layout_image", ("plan.png", source, "image/png")),
                    (
                        "approved_color_plan_image",
                        ("color.png", source, "image/png"),
                    ),
                ],
                data={
                    **common,
                    "semantic_layout": json.dumps(semantic, ensure_ascii=False),
                    "asset_parent_id": color_asset["id"],
                    "variants": "isometric_day,alternate_angle",
                },
            ),
        )
        assert axis_job["type"] == "AI_AXONOMETRIC"
        axis_asset = _asset_for_job(client, axis_job["id"])
        assert axis_job["result"]["assetId"] == axis_asset["id"]
        assert axis_asset["assetType"] == "ai_axonometric"
        assert axis_asset["parentAssetId"] == color_asset["id"]
        axis_capabilities = axis_asset["deliverables"]["capabilities"]
        assert axis_capabilities["multiView"] is False
        assert axis_capabilities["conceptAngles"] is True
        assert axis_capabilities["batchViewVariants"] is True

        unapproved_axis_parent = client.post(
            "/v1/ai-workflow/space-renders",
            files=[
                ("approved_layout_image", ("plan.png", source, "image/png")),
                (
                    "approved_color_plan_image",
                    ("color.png", source, "image/png"),
                ),
            ],
            data={
                **common,
                "asset_parent_id": axis_asset["id"],
                "selected_space_ids": "room_living",
            },
        )
        assert unapproved_axis_parent.status_code == 409

        approved_axis = client.post(
            f"/v1/assets/{axis_asset['id']}/approve",
            json={"variantId": "isometric_day"},
        )
        assert approved_axis.status_code == 200, approved_axis.text

        space_job = _completed_job(
            client,
            client.post(
                "/v1/ai-workflow/space-renders",
                files=[
                    ("approved_layout_image", ("plan.png", source, "image/png")),
                    (
                        "approved_color_plan_image",
                        ("color.png", source, "image/png"),
                    ),
                ],
                data={
                    **common,
                    "asset_parent_id": axis_asset["id"],
                    "selected_space_ids": '["room_living", "room_bedroom"]',
                },
            ),
        )
        assert space_job["type"] == "AI_SPACE_RENDER"
        assert {
            output["spaceId"] for output in space_job["result"]["outputs"]
        } == {"room_living", "room_bedroom"}
        space_asset = _asset_for_job(client, space_job["id"])
        assert space_job["result"]["assetId"] == space_asset["id"]
        assert space_asset["assetType"] == "ai_space_render"
        assert space_asset["parentAssetId"] == axis_asset["id"]
        assert space_asset["metadata"]["workflowStage"] == "space_render"
        assert space_asset["deliverables"]["capabilities"]["multiView"] is False
