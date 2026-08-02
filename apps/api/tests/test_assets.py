from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from app.database import SessionLocal
from app.jobs import PROCESSORS, create_job, run_job
from app.main import app


def scene_request(*, generation_mode: str = "structured_3d") -> dict[str, Any]:
    return {
        "schemaVersion": "0.3",
        "sourceImageUrl": "/artifacts/asset-test-source.png",
        "imageWidth": 640,
        "imageHeight": 420,
        "planWidthMm": 6000,
        "planDepthMm": 4000,
        "detectedBounds": {"x": 0, "y": 0, "width": 640, "height": 420},
        "walls": [
            {"id": "top", "x1": 0, "y1": 0, "x2": 640, "y2": 0},
            {"id": "right", "x1": 640, "y1": 0, "x2": 640, "y2": 420},
            {"id": "bottom", "x1": 640, "y1": 420, "x2": 0, "y2": 420},
            {"id": "left", "x1": 0, "y1": 420, "x2": 0, "y2": 0},
        ],
        "roomSelection": {"x": 0, "y": 0, "width": 640, "height": 420},
        "roomName": "资产测试客厅",
        "generationMode": generation_mode,
        "renderQuality": "final" if generation_mode == "ai_direct" else "base",
        "useBlender": generation_mode == "structured_3d",
    }


def fake_scene_result(payload: dict[str, Any]) -> dict[str, Any]:
    generation_mode = payload.get("generation_mode", "structured_3d")
    suffix = payload.get("asset_variant_type") or "original"
    model_delivery = (
        {
            "blendUrl": f"/artifacts/{suffix}.blend",
            "glbUrl": f"/artifacts/{suffix}.glb",
            "capabilities": {
                "editableModel": True,
                "multiView": True,
                "materialReplacement": True,
            },
        }
        if generation_mode == "structured_3d"
        else {"blendUrl": None, "glbUrl": None, "capabilities": {}}
    )
    return {
        "generationMode": generation_mode,
        "provider": "test-provider",
        "renderType": "test-render",
        "sceneDigest": f"digest-{suffix}",
        "topDownUrl": f"/artifacts/{suffix}-top.png",
        "roomPreviewUrl": f"/artifacts/{suffix}-room.png",
        "dollhouseUrl": f"/artifacts/{suffix}-dollhouse.png",
        "baseRenderUrl": f"/artifacts/{suffix}-base.png",
        "finalRenderUrl": f"/artifacts/{suffix}-final.png",
        "manifestUrl": f"/artifacts/{suffix}.json",
        "modelDelivery": model_delivery,
        "room": {"name": payload.get("room_name", "资产测试客厅")},
        "renderInfo": {"quality": payload.get("render_quality", "base")},
    }


def completed_job(client: TestClient, job_id: str) -> dict[str, Any]:
    response = client.get(f"/v1/jobs/{job_id}")
    assert response.status_code == 200
    job = response.json()
    assert job["status"] == "SUCCEEDED", job
    return job


def test_scene_jobs_become_assets_and_support_structured_variants(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setitem(PROCESSORS, "FLOORPLAN_SCENE", fake_scene_result)

    with TestClient(app) as client:
        response = client.post("/v1/floorplan-scenes", json=scene_request())
        assert response.status_code == 202
        source_job = completed_job(client, response.json()["id"])

        assets_response = client.get("/v1/assets?generationMode=structured_3d")
        assert assets_response.status_code == 200
        matching = [
            asset for asset in assets_response.json() if asset["jobId"] == source_job["id"]
        ]
        assert len(matching) == 1
        asset = matching[0]
        assert asset["ownerId"] == "local-user"
        assert asset["moduleKey"] == "floorplan"
        assert asset["moduleName"] == "户型识别与效果图"
        assert asset["assetType"] == "structured_scene"
        assert asset["thumbnailUrl"].endswith("original-final.png")
        assert asset["deliverables"]["blendUrl"].endswith("original.blend")
        assert asset["deliverables"]["glbUrl"].endswith("original.glb")
        assert asset["deliverables"]["capabilities"]["multiView"] is True
        assert "owner_id" not in asset

        detail = client.get(f"/v1/assets/{asset['id']}")
        assert detail.status_code == 200
        assert detail.json()["sourcePayload"]["generationMode"] == "structured_3d"
        assert detail.json()["sourceResult"]["modelDelivery"]["blendUrl"].endswith(
            "original.blend"
        )

        camera_response = client.post(
            f"/v1/assets/{asset['id']}/renders",
            json={
                "variantType": "camera",
                "cameraPresetId": "corner_02",
                "renderQuality": "final",
            },
        )
        assert camera_response.status_code == 202
        camera_job = completed_job(client, camera_response.json()["id"])
        assert camera_job["parentJobId"] == source_job["id"]
        assert camera_job["payload"]["asset_parent_id"] == asset["id"]
        assert camera_job["payload"]["asset_module_key"] == "floorplan"
        assert camera_job["payload"]["asset_variant_type"] == "camera"
        assert camera_job["payload"]["camera_preset_id"] == "corner_02"
        assert camera_job["payload"]["render_quality"] == "final"

        material_response = client.post(
            f"/v1/assets/{asset['id']}/renders",
            json={
                "variantType": "material",
                "stylePresetId": "natural_wood_v1",
                "renderQuality": "base",
            },
        )
        assert material_response.status_code == 202
        material_job = completed_job(client, material_response.json()["id"])
        assert material_job["payload"]["asset_parent_id"] == asset["id"]
        assert material_job["payload"]["asset_variant_type"] == "material"
        assert material_job["payload"]["style_preset_id"] == "natural_wood_v1"

        all_assets = client.get("/v1/assets").json()
        children = [item for item in all_assets if item["parentAssetId"] == asset["id"]]
        assert all(item["moduleKey"] == "floorplan" for item in children)
        assert {item["metadata"]["variantType"] for item in children} >= {
            "camera",
            "material",
        }
        assert len([item for item in all_assets if item["jobId"] == source_job["id"]]) == 1


def test_asset_list_backfills_historical_success_and_rejects_direct_variants(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setitem(PROCESSORS, "FLOORPLAN_SCENE", fake_scene_result)

    with TestClient(app) as client:
        session = SessionLocal()
        try:
            historical = create_job(
                session,
                job_type="FLOORPLAN_SCENE",
                payload={
                    "generation_mode": "ai_direct",
                    "room_name": "历史 AI 直出",
                    "source_image_url": "/artifacts/historical.png",
                },
            )
            historical.result = fake_scene_result(historical.payload)
            historical.status = "SUCCEEDED"
            session.commit()
            historical_job_id = historical.id
        finally:
            session.close()

        first_list = client.get("/v1/assets?generationMode=ai_direct")
        assert first_list.status_code == 200
        matching = [
            item for item in first_list.json() if item["jobId"] == historical_job_id
        ]
        assert len(matching) == 1
        direct_asset = matching[0]
        assert direct_asset["assetType"] == "ai_render"
        assert direct_asset["deliverables"]["blendUrl"] is None

        second_list = client.get("/v1/assets?generationMode=ai_direct").json()
        assert len([item for item in second_list if item["jobId"] == historical_job_id]) == 1

        response = client.post(
            f"/v1/assets/{direct_asset['id']}/renders",
            json={
                "variantType": "camera",
                "cameraPresetId": "corner_01",
                "renderQuality": "base",
            },
        )
        assert response.status_code == 409
        assert "AI 直出资产" in response.json()["detail"]


def test_asset_variant_request_requires_matching_preset() -> None:
    with TestClient(app) as client:
        response = client.post(
            "/v1/assets/missing/renders",
            json={"variantType": "camera", "renderQuality": "base"},
        )
        assert response.status_code == 422
        response = client.post(
            "/v1/assets/missing/renders",
            json={"variantType": "material", "renderQuality": "base"},
        )
        assert response.status_code == 422


def test_visual_module_jobs_are_saved_and_filterable_without_provider_calls(
    monkeypatch: MonkeyPatch,
) -> None:
    fixtures: dict[str, tuple[dict[str, Any], dict[str, Any], str, str]] = {
        "LAYOUT": (
            {"room_type": "living_room", "width_mm": 5200, "depth_mm": 4200},
            {
                "layouts": [
                    {
                        "layoutId": "layout_local_1",
                        "previewUrl": "/artifacts/layout-local.svg",
                    }
                ],
                "count": 1,
            },
            "layout",
            "deterministic",
        ),
        "LAYOUT_AI": (
            {
                "room_type": "whole_home",
                "width_mm": 8150,
                "depth_mm": 6060,
                "source_path": "/tmp/layout-source.png",
            },
            {
                "layouts": [
                    {
                        "layoutId": "layout_ai_1",
                        "previewUrl": "/artifacts/layout-ai.png",
                    }
                ],
                "count": 1,
                "generationMode": "ai_image",
                "provider": "mock-provider",
            },
            "layout",
            "ai_image",
        ),
        "WHITE_MODEL_RENDER": (
            {
                "source_path": "/tmp/white-source.png",
                "room_type": "bedroom",
                "generation_mode": "local_preview",
            },
            {
                "generationMode": "local_preview",
                "controlImageUrl": "/artifacts/white-control.png",
                "outputs": [
                    {"url": "/artifacts/white-result.png", "width": 800, "height": 600}
                ],
            },
            "white_model",
            "local_preview",
        ),
        "EFFECT_RENDER": (
            {"room_type": "dining_room", "use_blender": False},
            {
                "provider": "mock-local",
                "baseRenderUrl": "/artifacts/effect-base.png",
                "outputUrl": "/artifacts/effect-final.png",
            },
            "effect_render",
            "local_preview",
        ),
        "MATERIAL_REPLACEMENT": (
            {
                "source_path": "/tmp/material-source.png",
                "wall_style": "warm_gray",
                "floor_style": "oak_light",
            },
            {
                "outputUrl": "/artifacts/material-final.png",
                "comparisonUrl": "/artifacts/material-comparison.png",
            },
            "material_replacement",
            "local_edit",
        ),
    }

    with TestClient(app) as client:
        job_ids: dict[str, tuple[str, str]] = {}
        runnable_job_ids: list[str] = []
        session = SessionLocal()
        try:
            for job_type, (payload, result, module_key, generation_mode) in fixtures.items():
                job = create_job(session, job_type=job_type, payload=payload)
                job_ids[job.id] = (module_key, generation_mode)
                if job_type == "LAYOUT":
                    # Retired solver jobs remain readable through asset backfill, but
                    # can no longer be created or executed by the public API.
                    job.result = result
                    job.status = "SUCCEEDED"
                    session.commit()
                    continue
                monkeypatch.setitem(
                    PROCESSORS,
                    job_type,
                    lambda _payload, expected=result: expected,
                )
                runnable_job_ids.append(job.id)
        finally:
            session.close()

        for job_id in runnable_job_ids:
            run_job(job_id)

        modules_response = client.get("/v1/assets/modules")
        assert modules_response.status_code == 200
        modules_by_key = {
            item["key"]: item for item in modules_response.json()
        }
        assert set(modules_by_key) == {
            "floorplan",
            "layout",
            "white_model",
            "effect_render",
            "material_replacement",
        }
        assert modules_by_key["floorplan"]["name"] == "户型识别与效果图"
        assert "规则求解" not in modules_by_key["layout"]["description"]
        assert modules_by_key["effect_render"]["name"] == "历史快速房间渲染"

        assets_response = client.get("/v1/assets?limit=100")
        assert assets_response.status_code == 200
        assets_by_job = {
            item["jobId"]: item
            for item in assets_response.json()
            if item["jobId"] in job_ids
        }
        assert set(assets_by_job) == set(job_ids)
        for job_id, (module_key, generation_mode) in job_ids.items():
            asset = assets_by_job[job_id]
            assert asset["moduleKey"] == module_key
            assert asset["moduleName"]
            assert asset["metadata"]["moduleKey"] == module_key
            assert asset["metadata"]["jobType"] in fixtures
            assert asset["generationMode"] == generation_mode
            assert asset["thumbnailUrl"]

        for module_key in {
            "layout",
            "white_model",
            "effect_render",
            "material_replacement",
        }:
            filtered = client.get(f"/v1/assets?moduleKey={module_key}&limit=100")
            assert filtered.status_code == 200
            assert filtered.json()
            assert all(item["moduleKey"] == module_key for item in filtered.json())


def test_asset_backfill_infers_module_for_historical_non_scene_job() -> None:
    with TestClient(app) as client:
        session = SessionLocal()
        try:
            historical = create_job(
                session,
                job_type="WHITE_MODEL_RENDER",
                payload={
                    "source_path": "/tmp/historical-white.png",
                },
            )
            historical.result = {
                "outputs": [{"url": "/artifacts/historical-white-result.png"}],
            }
            historical.status = "SUCCEEDED"
            session.commit()
            historical_job_id = historical.id
        finally:
            session.close()

        response = client.get("/v1/assets?moduleKey=white_model&limit=100")
        assert response.status_code == 200
        matches = [item for item in response.json() if item["jobId"] == historical_job_id]
        assert len(matches) == 1
        assert matches[0]["moduleName"] == "白模渲染"
        assert matches[0]["generationMode"] == "local_preview"
        assert matches[0]["metadata"]["jobType"] == "WHITE_MODEL_RENDER"


def test_child_asset_inherits_parent_module_before_explicit_job_hint(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setitem(PROCESSORS, "FLOORPLAN_SCENE", fake_scene_result)

    with TestClient(app) as client:
        session = SessionLocal()
        try:
            parent_job = create_job(
                session,
                job_type="LAYOUT",
                payload={
                    "room_type": "living_room",
                    "width_mm": 5200,
                    "depth_mm": 4200,
                },
            )
            parent_job.result = {
                "layouts": [{"previewUrl": "/artifacts/parent-layout.svg"}],
                "count": 1,
            }
            parent_job.status = "SUCCEEDED"
            session.commit()
            parent_job_id = parent_job.id
        finally:
            session.close()
        parent_asset = next(
            item
            for item in client.get("/v1/assets?moduleKey=layout&limit=100").json()
            if item["jobId"] == parent_job_id
        )

        child_payload = scene_request()
        child_payload["asset_parent_id"] = parent_asset["id"]
        child_payload["asset_module_key"] = "material_replacement"
        session = SessionLocal()
        try:
            child_job = create_job(
                session,
                job_type="FLOORPLAN_SCENE",
                payload=child_payload,
            )
            child_job_id = child_job.id
        finally:
            session.close()
        run_job(child_job_id)

        child_asset = next(
            item
            for item in client.get("/v1/assets?moduleKey=layout&limit=100").json()
            if item["jobId"] == child_job_id
        )
        assert child_asset["parentAssetId"] == parent_asset["id"]
        assert child_asset["moduleKey"] == "layout"
        assert child_asset["metadata"]["moduleName"] == "AI 平面布局"


def test_successful_job_without_displayable_output_does_not_create_asset(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setitem(
        PROCESSORS,
        "EFFECT_RENDER",
        lambda _payload: {"provider": "mock", "notice": "没有图片产物"},
    )

    with TestClient(app) as client:
        session = SessionLocal()
        try:
            job = create_job(
                session,
                job_type="EFFECT_RENDER",
                payload={"room_type": "living_room", "use_blender": False},
            )
            job_id = job.id
        finally:
            session.close()
        run_job(job_id)

        assert completed_job(client, job_id)["status"] == "SUCCEEDED"
        assets = client.get("/v1/assets?moduleKey=effect_render&limit=100").json()
        assert all(item["jobId"] != job_id for item in assets)
