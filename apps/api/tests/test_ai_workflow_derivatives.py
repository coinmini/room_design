from __future__ import annotations

import hashlib
import json
from pathlib import Path
from time import monotonic, sleep
from typing import Any, Callable

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from pytest import MonkeyPatch

from app.assets import ensure_scene_asset, scene_asset_read
from app.canvas import canvas_node_id
from app.config import settings
from app.database import SessionLocal, init_db
from app.jobs import PROCESSORS, create_job
from app.main import app
from app.processors import ai_workflow
from app.processors.common import ProcessorError

# 本文件不依赖其他测试的执行顺序：自行确保测试库建表 + 轻量迁移
init_db()


def _image_bytes(value: int = 220, *, width: int = 72, height: int = 48) -> bytes:
    image = np.full((height, width, 3), value, dtype=np.uint8)
    success, encoded = cv2.imencode(".png", image)
    assert success
    return encoded.tobytes()


def _semantic_layout() -> dict[str, Any]:
    return {
        "version": "0.5",
        "plan": {"widthMm": 7200, "depthMm": 4800},
        "rooms": [
            {
                "id": "room_living",
                "name": "客厅",
                "type": "living_room",
                "rect": {"xMm": 0, "yMm": 0, "widthMm": 4200, "depthMm": 4800},
            }
        ],
        "walls": [],
        "openings": [],
        "furniture": [],
    }


def _fake_derivative_processor(stage: str) -> Callable[[dict[str, Any]], dict[str, Any]]:
    def run(payload: dict[str, Any]) -> dict[str, Any]:
        if stage == "style_scheme":
            variant_ids = [f"style_{item}" for item in payload["variants"]]
        elif stage == "tone_scheme":
            variant_ids = [f"tone_{item}" for item in payload["variants"]]
        else:
            variant_ids = ["local_edit"]
        outputs = []
        source_bytes = Path(payload["source_space_path"]).read_bytes()
        for variant_id in variant_ids:
            output_path = settings.artifact_dir / f"{stage}-{variant_id}.png"
            output_path.write_bytes(source_bytes)
            outputs.append(
                {
                    "variantId": variant_id,
                    "variantGroupId": payload["variant_group_id"],
                    "status": "succeeded",
                    "spaceId": payload["space_id"],
                    "url": f"/artifacts/{output_path.name}",
                    "provider": "mock-kuyao",
                    "model": "gpt-image-2",
                }
            )
        return {
            "workflowStage": stage,
            "variantGroupId": payload["variant_group_id"],
            "generationMode": "ai_image",
            "provider": "mock-kuyao",
            "model": "gpt-image-2",
            "promptVersion": "pure-ai-design-workflow-test",
            "sourceSpace": {
                "spaceId": payload["space_id"],
                "versionId": payload.get("source_space_version_id"),
                "assetId": payload["asset_parent_id"],
                "parentApprovedVersionId": payload["parent_approved_version_id"],
                "parentVariantId": payload["parent_variant_id"],
                "sourceSha256": payload["source_sha256"],
                "sha256": payload["source_sha256"],
                "approvalConfirmed": payload["source_approved"],
            },
            "semanticInput": {"sha256": "semantic-test"},
            "spaceId": payload["space_id"],
            "outputs": outputs,
            "count": len(outputs),
            "succeededCount": len(outputs),
            "failedCount": 0,
            "batchStatus": "complete",
            "approvalStatus": "review_required",
        }

    return run


def _create_space_asset(project_id: str, source: bytes) -> dict[str, Any]:
    output_path = settings.artifact_dir / "space-room-living.png"
    output_path.write_bytes(source)
    session = SessionLocal()
    try:
        job = create_job(
            session,
            job_type="AI_SPACE_RENDER",
            payload={
                "asset_module_key": "ai_workflow",
                "workflow_stage": "space_render",
                "variant_group_id": "space-group",
                "approved_layout_path": "/tmp/plan.png",
            },
            project_id=project_id,
        )
        job.result = {
            "workflowStage": "space_render",
            "variantGroupId": "space-group",
            "generationMode": "ai_image",
            "provider": "mock-kuyao",
            "outputs": [
                {
                    "variantId": "space_room_living",
                    "variantGroupId": "space-group",
                    "spaceId": "room_living",
                    "spaceName": "客厅",
                    "status": "succeeded",
                    "url": f"/artifacts/{output_path.name}",
                }
            ],
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
    return next(item for item in response.json() if item["jobId"] == job_id)


def test_stages_6_to_8_require_approved_parent_and_keep_space_lineage(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setitem(
        PROCESSORS,
        "AI_STYLE_SCHEME",
        _fake_derivative_processor("style_scheme"),
    )
    monkeypatch.setitem(
        PROCESSORS,
        "AI_TONE_SCHEME",
        _fake_derivative_processor("tone_scheme"),
    )
    monkeypatch.setitem(
        PROCESSORS,
        "AI_LOCAL_EDIT",
        _fake_derivative_processor("local_edit"),
    )
    source = _image_bytes()
    semantic = json.dumps(_semantic_layout(), ensure_ascii=False)

    with TestClient(app) as client:
        project_id = client.post("/v1/projects", json={"name": "阶段 6～8"}).json()["id"]
        space_asset = _create_space_asset(project_id, source)
        common = {
            "semantic_layout": semantic,
            "space_id": "room_living",
            "source_approved": "true",
            "project_id": project_id,
        }

        unapproved = client.post(
            "/v1/ai-workflow/style-schemes",
            files={"source_space_image": ("space.png", source, "image/png")},
            data={
                **common,
                "asset_parent_id": space_asset["id"],
                "source_space_version_id": "not-approved",
            },
        )
        assert unapproved.status_code == 409
        assert "尚未审批" in unapproved.json()["detail"]

        approved_space = client.post(
            f"/v1/assets/{space_asset['id']}/approve",
            json={"variantId": "space_room_living"},
        )
        assert approved_space.status_code == 200
        space_version = approved_space.json()["metadata"]["approvedVersionId"]

        stale_version = client.post(
            "/v1/ai-workflow/style-schemes",
            files={"source_space_image": ("space.png", source, "image/png")},
            data={
                **common,
                "asset_parent_id": space_asset["id"],
                "source_space_version_id": "stale-version",
            },
        )
        assert stale_version.status_code == 409
        assert "已批准版本" in stale_version.json()["detail"]

        mismatched_image = client.post(
            "/v1/ai-workflow/style-schemes",
            files={
                "source_space_image": (
                    "different.png",
                    _image_bytes(90),
                    "image/png",
                )
            },
            data={
                **common,
                "asset_parent_id": space_asset["id"],
                "source_space_version_id": space_version,
            },
        )
        assert mismatched_image.status_code == 409
        assert "批准输出不一致" in mismatched_image.json()["detail"]

        style_job = _completed_job(
            client,
            client.post(
                "/v1/ai-workflow/style-schemes",
                files={"source_space_image": ("space.png", source, "image/png")},
                data={
                    **common,
                    "asset_parent_id": space_asset["id"],
                    "source_space_version_id": space_version,
                },
            ),
        )
        assert style_job["type"] == "AI_STYLE_SCHEME"
        assert style_job["payload"]["variants"] == [
            "modern_minimal",
            "natural_wood",
            "midcentury_vintage",
        ]
        source_sha256 = hashlib.sha256(source).hexdigest()
        assert style_job["payload"]["parent_approved_version_id"] == space_version
        assert style_job["payload"]["parent_variant_id"] == "space_room_living"
        assert style_job["payload"]["source_sha256"] == source_sha256
        style_asset = _asset_for_job(client, style_job["id"])
        assert style_asset["assetType"] == "ai_style_scheme"
        assert style_asset["parentAssetId"] == space_asset["id"]
        assert style_asset["metadata"]["workflowStage"] == "style_scheme"
        assert style_asset["metadata"]["spaceId"] == "room_living"
        assert style_asset["metadata"]["parentApprovedVersionId"] == space_version
        assert style_asset["metadata"]["parentVariantId"] == "space_room_living"
        assert style_asset["metadata"]["sourceSha256"] == source_sha256
        assert style_asset["deliverables"]["capabilities"]["styleVariants"] is True

        tone_before_style_approval = client.post(
            "/v1/ai-workflow/tone-schemes",
            files={"source_space_image": ("style.png", source, "image/png")},
            data={
                **common,
                "asset_parent_id": style_asset["id"],
                "source_space_version_id": "not-approved",
            },
        )
        assert tone_before_style_approval.status_code == 409

        approved_style = client.post(
            f"/v1/assets/{style_asset['id']}/approve",
            json={"variantId": "style_modern_minimal"},
        )
        assert approved_style.status_code == 200
        style_version = approved_style.json()["metadata"]["approvedVersionId"]
        approved_style_again = client.post(
            f"/v1/assets/{style_asset['id']}/approve",
            json={"variantId": "style_modern_minimal"},
        )
        assert approved_style_again.status_code == 200
        assert (
            approved_style_again.json()["metadata"]["approvedVersionId"]
            == style_version
        )
        tone_job = _completed_job(
            client,
            client.post(
                "/v1/ai-workflow/tone-schemes",
                files={"source_space_image": ("style.png", source, "image/png")},
                data={
                    **common,
                    "asset_parent_id": style_asset["id"],
                    "source_space_version_id": style_version,
                },
            ),
        )
        assert tone_job["payload"]["variants"] == [
            "warm_gold_day",
            "neutral_dusk",
            "cool_blue_night",
        ]
        tone_asset = _asset_for_job(client, tone_job["id"])
        assert tone_asset["assetType"] == "ai_tone_scheme"
        assert tone_asset["parentAssetId"] == style_asset["id"]
        assert tone_asset["deliverables"]["capabilities"]["toneVariants"] is True
        assert tone_asset["metadata"]["parentApprovedVersionId"] == style_version
        assert tone_asset["metadata"]["parentVariantId"] == "style_modern_minimal"

        # W0-X：已有下游时仍可批准其他 variant 以分叉（不再 409）
        changed_style_approval = client.post(
            f"/v1/assets/{style_asset['id']}/approve",
            json={"variantId": "style_natural_wood"},
        )
        assert changed_style_approval.status_code == 200, changed_style_approval.text
        fork_meta = changed_style_approval.json()["metadata"]
        assert fork_meta["approvedVariantId"] == "style_natural_wood"
        assert "style_modern_minimal" in fork_meta.get("variantApprovals", {})
        assert "style_natural_wood" in fork_meta.get("variantApprovals", {})

        approved_tone = client.post(
            f"/v1/assets/{tone_asset['id']}/approve",
            json={"variantId": "tone_warm_gold_day"},
        )
        assert approved_tone.status_code == 200
        tone_version = approved_tone.json()["metadata"]["approvedVersionId"]
        mark_array = np.full((48, 72, 3), 25, dtype=np.uint8)
        mark_array[10:30, 20:50] = (48, 59, 255)  # #FF3B30 annotation marks
        success, encoded = cv2.imencode(".png", mark_array)
        assert success
        mark = encoded.tobytes()
        local_job = _completed_job(
            client,
            client.post(
                "/v1/ai-workflow/local-edits",
                files={
                    "source_space_image": ("tone.png", source, "image/png"),
                    "mark_image": ("mark.png", mark, "image/png"),
                },
                data={
                    **common,
                    "asset_parent_id": tone_asset["id"],
                    "source_space_version_id": tone_version,
                    "edit_prompt": "只把标记处的单椅替换为浅色布艺休闲椅",
                },
            ),
        )
        local_asset = _asset_for_job(client, local_job["id"])
        assert local_asset["assetType"] == "ai_local_edit"
        assert local_asset["parentAssetId"] == tone_asset["id"]
        assert local_asset["deliverables"]["capabilities"]["maskedEdit"] is True
        assert local_asset["metadata"]["parentApprovedVersionId"] == tone_version
        assert local_asset["metadata"]["parentVariantId"] == "tone_warm_gold_day"
        assert local_asset["metadata"]["sourceSha256"] == source_sha256


def test_local_edit_hard_restores_all_unmasked_pixels(
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = np.full((24, 32, 3), 25, dtype=np.uint8)
    generated = np.full((24, 32, 3), 220, dtype=np.uint8)
    mark = source.copy()
    mark[7:16, 10:22] = (48, 59, 255)  # #FF3B30 annotation marks
    source_path = tmp_path / "source.png"
    generated_path = tmp_path / "generated.png"
    mark_path = tmp_path / "mark.png"
    assert cv2.imwrite(str(source_path), source)
    assert cv2.imwrite(str(generated_path), generated)
    assert cv2.imwrite(str(mark_path), mark)
    settings.artifact_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(ai_workflow, "_require_provider", lambda: None)
    monkeypatch.setattr(
        ai_workflow,
        "_generate",
        lambda **_kwargs: {
            "path": str(generated_path),
            "url": "/artifacts/provider.png",
            "provider": "mock-kuyao",
            "model": "gpt-image-2",
            "size": "1024x1024",
            "quality": "high",
        },
    )
    result = ai_workflow.run_ai_local_edit(
        {
            "source_space_path": str(source_path),
            "source_space_version_id": "tone-v1",
            "source_approved": True,
            "semantic_layout": _semantic_layout(),
            "space_id": "room_living",
            "variant_group_id": "local-group",
            "mark_path": str(mark_path),
            "edit_prompt": "替换标记处的单椅",
            "asset_parent_id": "asset-tone",
        }
    )
    output = result["outputs"][0]
    assert output["unmaskedPixelsRestored"] is True
    # Recompute the expected extraction (red threshold + source diff + close +
    # contour fill + dilation) for comparison.
    blue, green, red = cv2.split(mark.astype(np.int16))
    red_like = (red > 150) & (red - green > 60) & (red - blue > 60)
    diff = np.abs(mark.astype(np.int16) - source.astype(np.int16)).sum(axis=2)
    strokes = (red_like & (diff > 40)).astype(np.uint8) * 255
    closed = cv2.morphologyEx(
        strokes, cv2.MORPH_CLOSE, np.ones((9, 9), dtype=np.uint8), iterations=2
    )
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_area = max(64.0, float(mark.shape[0] * mark.shape[1]) * 0.0002)
    kept = [contour for contour in contours if cv2.contourArea(contour) >= min_area]
    expected = strokes
    if kept:
        filled = np.zeros_like(strokes)
        cv2.drawContours(filled, kept, -1, 255, thickness=cv2.FILLED)
        expected = cv2.bitwise_or(filled, strokes)
    expected = cv2.dilate(expected, np.ones((3, 3), dtype=np.uint8), iterations=2)
    selected = expected >= 128
    assert output["maskCoverage"] == round(float(selected.mean()), 6)
    composite = cv2.imread(str(settings.artifact_dir / Path(output["url"]).name))
    assert composite is not None
    assert np.array_equal(composite[~selected], source[~selected])
    assert np.array_equal(composite[selected], generated[selected])


def test_local_edit_fills_circled_region(tmp_path: Path) -> None:
    """A hollow red ring (user circles an object) must become a filled mask."""

    source = np.full((60, 80, 3), 25, dtype=np.uint8)
    source_path = tmp_path / "source.png"
    assert cv2.imwrite(str(source_path), source)
    mark = source.copy()
    cv2.rectangle(mark, (20, 15), (59, 44), (48, 59, 255), thickness=3)
    mark_path = tmp_path / "mark.png"
    assert cv2.imwrite(str(mark_path), mark)
    settings.artifact_dir.mkdir(parents=True, exist_ok=True)
    mask_path, coverage = ai_workflow._extract_mark_mask(
        source=source_path, mark=mark_path
    )
    mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
    assert mask is not None
    # The ring interior (e.g. the ring's center) must be part of the mask.
    assert mask[30, 40] >= 128
    ring_only = cv2.dilate(
        (cv2.inRange(mark, (48, 59, 255), (48, 59, 255)) > 0).astype(np.uint8) * 255,
        np.ones((3, 3), dtype=np.uint8),
        iterations=2,
    )
    assert coverage > float((ring_only >= 128).mean())


def test_local_edit_rejects_mark_image_without_red_marks(
    monkeypatch: MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = np.full((24, 32, 3), 25, dtype=np.uint8)
    source_path = tmp_path / "source.png"
    mark_path = tmp_path / "mark.png"
    assert cv2.imwrite(str(source_path), source)
    assert cv2.imwrite(str(mark_path), source)  # no red marks at all
    settings.artifact_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(ai_workflow, "_require_provider", lambda: None)
    with pytest.raises(ProcessorError, match="未检测到红色标记区域"):
        ai_workflow.run_ai_local_edit(
            {
                "source_space_path": str(source_path),
                "source_space_version_id": "tone-v1",
                "source_approved": True,
                "semantic_layout": _semantic_layout(),
                "space_id": "room_living",
                "variant_group_id": "local-group",
                "mark_path": str(mark_path),
                "edit_prompt": "替换标记处的单椅",
                "asset_parent_id": "asset-tone",
            }
        )


def test_stages_6_to_8_require_asset_parent_id() -> None:
    """W0-b：06/07/08 的 asset_parent_id 为 Form 必填，缺失直接 422。"""
    source = _image_bytes()
    semantic = json.dumps(_semantic_layout(), ensure_ascii=False)
    with TestClient(app) as client:
        project_id = client.post(
            "/v1/projects", json={"name": "阶段 6～8 必填 parent"}
        ).json()["id"]
        common = {
            "semantic_layout": semantic,
            "space_id": "room_living",
            "source_approved": "true",
            "source_space_version_id": "any",
            "project_id": project_id,
        }
        style = client.post(
            "/v1/ai-workflow/style-schemes",
            files={"source_space_image": ("space.png", source, "image/png")},
            data=common,
        )
        tone = client.post(
            "/v1/ai-workflow/tone-schemes",
            files={"source_space_image": ("style.png", source, "image/png")},
            data=common,
        )
        mark = np.full((48, 72, 3), 25, dtype=np.uint8)
        mark[10:30, 20:50] = (48, 59, 255)
        ok, encoded = cv2.imencode(".png", mark)
        assert ok
        local = client.post(
            "/v1/ai-workflow/local-edits",
            files={
                "source_space_image": ("tone.png", source, "image/png"),
                "mark_image": ("mark.png", encoded.tobytes(), "image/png"),
            },
            data={**common, "edit_prompt": "替换标记处"},
        )
        assert style.status_code == 422, style.text
        assert tone.status_code == 422, tone.text
        assert local.status_code == 422, local.text


def test_approved_style_variants_expand_on_canvas_graph(
    monkeypatch: MonkeyPatch,
) -> None:
    """W0-e：阶段 6 多图 asset 在 canvas-graph 中按 variant 展开（仍一 job 一资产）。"""
    monkeypatch.setitem(
        PROCESSORS,
        "AI_STYLE_SCHEME",
        _fake_derivative_processor("style_scheme"),
    )
    source = _image_bytes()
    semantic = json.dumps(_semantic_layout(), ensure_ascii=False)

    with TestClient(app) as client:
        project_id = client.post(
            "/v1/projects", json={"name": "画布展开 风格方案"}
        ).json()["id"]
        space_asset = _create_space_asset(project_id, source)
        approved_space = client.post(
            f"/v1/assets/{space_asset['id']}/approve",
            json={"variantId": "space_room_living"},
        )
        assert approved_space.status_code == 200
        space_version = approved_space.json()["metadata"]["approvedVersionId"]

        style_job = _completed_job(
            client,
            client.post(
                "/v1/ai-workflow/style-schemes",
                files={"source_space_image": ("space.png", source, "image/png")},
                data={
                    "semantic_layout": semantic,
                    "space_id": "room_living",
                    "source_approved": "true",
                    "project_id": project_id,
                    "asset_parent_id": space_asset["id"],
                    "source_space_version_id": space_version,
                },
            ),
        )
        style_asset = _asset_for_job(client, style_job["id"])
        # 一 job 一资产（W0-X 前仍成立）
        siblings = [
            item
            for item in client.get("/v1/assets?moduleKey=ai_workflow&limit=100").json()
            if item["jobId"] == style_job["id"]
        ]
        assert len(siblings) == 1

        graph = client.get(f"/v1/projects/{project_id}/canvas-graph")
        assert graph.status_code == 200
        body = graph.json()
        node_ids = {node["id"] for node in body["nodes"]}
        assert canvas_node_id(style_asset["id"], "style_modern_minimal") in node_ids
        assert canvas_node_id(style_asset["id"], "style_natural_wood") in node_ids
        assert canvas_node_id(style_asset["id"], "style_midcentury_vintage") in node_ids
        style_nodes = [n for n in body["nodes"] if n["assetId"] == style_asset["id"]]
        assert len(style_nodes) == 3
        assert all(n["workflowStage"] == "style_scheme" for n in style_nodes)
        assert all(
            n["parentVariantId"] == "space_room_living" for n in style_nodes
        )
