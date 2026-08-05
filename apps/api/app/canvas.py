"""W0-e：统一「资产 → 逐图变体」展开服务 + 项目画布图谱组装。

画布节点身份 = ``{asset_id}:{variant_id}``。一个 SceneAsset 对应一批生成结果
（彩平 4 图、分空间最多 12 图等），本模块把五种互不相同的 deliverables 形状
（ai_workflow / layout / floorplan / white_model / 其他单图）展开成统一的
逐图变体列表，供画布视图与后续的 canvas_nodes 落位使用。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.assets import AI_WORKFLOW_JOB_TYPES, ASSET_JOB_TYPES
from app.models import Job, SceneAsset


def _mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _pair_by_index(
    urls: list[str],
    variant_ids: list[str],
    *,
    prefix: str,
) -> list[dict[str, str]]:
    """旧数据回退：urls 与 metadata.variantIds 靠数组下标配对。

    新数据请优先使用结构化字段（如 layoutVariants），本函数仅用于兼容
    W0-e 之前落库、且无法重建 deliverables 的存量资产。
    """
    pairs: list[dict[str, str]] = []
    for index, url in enumerate(urls):
        variant_id = (
            variant_ids[index] if index < len(variant_ids) else f"{prefix}-{index}"
        )
        pairs.append({"variantId": variant_id, "url": url})
    return pairs


def expand_asset_variants(asset: SceneAsset) -> list[dict[str, Any]]:
    """把一个 SceneAsset 展开为逐图变体列表。

    返回的每个变体带画布节点所需的最小字段；无可见图片的资产返回空列表。
    """
    deliverables = _mapping(asset.deliverables)
    metadata = _mapping(asset.metadata_json)
    job_type = str(metadata.get("jobType") or "")
    is_approved = metadata.get("approvalStatus") == "approved"
    approved_variant_id = metadata.get("approvedVariantId") if is_approved else None
    approved_version_id = metadata.get("approvedVersionId") if is_approved else None
    # W0-X：多 variant 可同时处于已批准（分叉）
    variant_approvals = metadata.get("variantApprovals")
    approval_versions: dict[str, str] = {}
    if isinstance(variant_approvals, dict):
        for key, entry in variant_approvals.items():
            if isinstance(entry, dict) and isinstance(entry.get("versionId"), str):
                approval_versions[str(key)] = entry["versionId"]
    if isinstance(approved_variant_id, str) and isinstance(approved_version_id, str):
        approval_versions.setdefault(approved_variant_id, approved_version_id)
    full_url = deliverables.get("fullUrl")

    def make(
        variant_id: str,
        url: str | None,
        *,
        label: str | None = None,
        status: str = "succeeded",
    ) -> dict[str, Any] | None:
        if not isinstance(url, str) or not url:
            return None
        approved = variant_id in approval_versions
        return {
            "assetId": asset.id,
            "variantId": variant_id,
            "url": url,
            # 资产级 webp 缩略图只对代表图（fullUrl）存在；其余变体前端先用原图
            "thumbnailUrl": asset.thumbnail_url if url == full_url else None,
            "label": label or variant_id,
            "status": status,
            "approved": approved,
            "approvedVersionId": approval_versions.get(variant_id),
        }

    variants: list[dict[str, Any]] = []

    if job_type in AI_WORKFLOW_JOB_TYPES:
        # ai_workflow：outputs 已是结构化数组（variantId/url/status）
        outputs = deliverables.get("outputs")
        if isinstance(outputs, list):
            for output in outputs:
                if not isinstance(output, dict):
                    continue
                variant = make(
                    str(output.get("variantId") or f"output-{len(variants)}"),
                    output.get("url"),
                    status=str(output.get("status") or "succeeded"),
                )
                if variant is not None:
                    variants.append(variant)

    elif job_type in {"LAYOUT", "LAYOUT_AI"}:
        # layout：优先结构化 layoutVariants（W0-e 起落库），旧数据按下标配对回退
        layout_variants = deliverables.get("layoutVariants")
        if isinstance(layout_variants, list) and layout_variants:
            for index, entry in enumerate(layout_variants):
                if not isinstance(entry, dict):
                    continue
                variant = make(
                    str(entry.get("layoutId") or f"layout-{index}"),
                    entry.get("previewUrl"),
                )
                if variant is not None:
                    variants.append(variant)
        else:
            preview_urls = [
                url
                for url in (deliverables.get("previewUrls") or [])
                if isinstance(url, str) and url
            ]
            variant_ids = [
                str(item)
                for item in (metadata.get("variantIds") or [])
                if isinstance(item, str)
            ]
            for pair in _pair_by_index(preview_urls, variant_ids, prefix="layout"):
                variant = make(pair["variantId"], pair["url"])
                if variant is not None:
                    variants.append(variant)

    elif job_type == "FLOORPLAN_ANALYZE":
        variant = make(
            "analysis",
            deliverables.get("overlayPreviewUrl")
            or deliverables.get("sourceImageUrl"),
            label="结构识别",
        )
        if variant is not None:
            variants.append(variant)

    elif job_type == "WHITE_MODEL_RENDER":
        output_urls = [
            url
            for url in (deliverables.get("outputUrls") or [])
            if isinstance(url, str) and url
        ]
        variant_ids = [
            str(item)
            for item in (metadata.get("variantIds") or [])
            if isinstance(item, str)
        ]
        for pair in _pair_by_index(output_urls, variant_ids, prefix="white"):
            variant = make(pair["variantId"], pair["url"])
            if variant is not None:
                variants.append(variant)

    if not variants:
        # 单图资产（effect / material / floorplan_scene 等）：取代表图
        for key in (
            "finalRenderUrl",
            "previewUrl",
            "overlayPreviewUrl",
            "dollhouseUrl",
            "baseRenderUrl",
            "topDownUrl",
            "comparisonUrl",
        ):
            variant = make("default", deliverables.get(key), label=asset.title)
            if variant is not None:
                variants.append(variant)
                break

    return variants


def partial_node_id(job_id: str, variant_id: str) -> str:
    """临时节点身份（取消/失败 job 的 partial output）：``partial:{jobId}:{variantId}``"""
    return f"partial:{job_id}:{variant_id}"


def expand_job_partial_outputs(job: Job) -> list[dict[str, Any]]:
    """从 CANCELLED/FAILED job 的 result 中提取仍可视的 partial outputs。

    只返回带 url 的成功/部分成功输出；无可见结果的 job 返回空列表。
    """
    if job.status not in {"CANCELED", "FAILED"} or not job.result:
        return []
    result = _mapping(job.result)
    job_type = job.type

    def make(variant_id: str, url: str | None, *, label: str | None = None) -> dict[str, Any] | None:
        if not isinstance(url, str) or not url:
            return None
        return {
            "jobId": job.id,
            "variantId": variant_id,
            "url": url,
            "thumbnailUrl": None,
            "label": label or variant_id,
            "status": "partial",
            "approved": False,
            "approvedVersionId": None,
        }

    variants: list[dict[str, Any]] = []

    if job_type in AI_WORKFLOW_JOB_TYPES:
        outputs = result.get("outputs")
        if isinstance(outputs, list):
            for output in outputs:
                if not isinstance(output, dict):
                    continue
                # 只保留带 url 的输出（不管 outputs 里标 succeeded 还是 failed，
                # 只要 url 存在就说明文件已落盘、可预览）
                variant = make(
                    str(output.get("variantId") or f"output-{len(variants)}"),
                    output.get("url"),
                )
                if variant is not None:
                    variants.append(variant)

    elif job_type in {"LAYOUT", "LAYOUT_AI"}:
        layouts = result.get("layouts")
        if isinstance(layouts, list):
            for index, entry in enumerate(layouts):
                if not isinstance(entry, dict):
                    continue
                variant = make(
                    str(entry.get("layoutId") or f"layout-{index}"),
                    entry.get("previewUrl"),
                )
                if variant is not None:
                    variants.append(variant)

    elif job_type == "FLOORPLAN_ANALYZE":
        for key in ("overlayPreviewUrl", "sourceImageUrl"):
            variant = make("analysis", result.get(key), label="结构识别")
            if variant is not None:
                variants.append(variant)
                break

    elif job_type == "WHITE_MODEL_RENDER":
        outputs = result.get("outputs")
        if isinstance(outputs, list):
            for index, output in enumerate(outputs):
                if isinstance(output, dict):
                    variant = make(
                        str(output.get("variantId") or f"white-{index}"),
                        output.get("url"),
                    )
                else:
                    variant = make(f"white-{index}", output)
                if variant is not None:
                    variants.append(variant)

    if not variants:
        # 单图回退
        for key in (
            "outputUrl",
            "finalRenderUrl",
            "previewUrl",
            "overlayPreviewUrl",
            "dollhouseUrl",
            "baseRenderUrl",
            "topDownUrl",
            "comparisonUrl",
        ):
            variant = make("default", result.get(key))
            if variant is not None:
                variants.append(variant)
                break

    return variants


def canvas_node_id(asset_id: str, variant_id: str) -> str:
    """画布节点身份：``{assetId}:{variantId}``。"""
    return f"{asset_id}:{variant_id}"


def build_project_canvas_graph(
    session: Session,
    project_id: str,
    *,
    include_orphans: bool = False,
) -> dict[str, Any]:
    """组装项目画布图谱：逐图节点 + parent→child 派生连线（逻辑结构，不含坐标）。

    坐标与视口状态由 canvas_nodes / canvases 表（W0-d）承载；本图谱是
    只读事实层，前端落位时以节点 id 关联。

    include_orphans=True 时合并 project_id IS NULL 的存量资产（历史前端常空置项目框）。
    """
    assets = list(
        session.scalars(
            select(SceneAsset)
            .where(SceneAsset.project_id == project_id)
            .order_by(SceneAsset.created_at.asc())
        )
    )
    included_orphans = False
    if include_orphans:
        orphans = list(
            session.scalars(
                select(SceneAsset)
                .where(SceneAsset.project_id.is_(None))
                .order_by(SceneAsset.created_at.asc())
            )
        )
        if orphans:
            included_orphans = True
            seen = {asset.id for asset in assets}
            for orphan in orphans:
                if orphan.id not in seen:
                    assets.append(orphan)
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    for asset in assets:
        metadata = _mapping(asset.metadata_json)
        variants = expand_asset_variants(asset)
        if not variants:
            continue
        parent_variant_id = metadata.get("parentVariantId")
        # 存量数据纠偏：layout_plan 资产强制 layout，避免继承 parent 的 floorplan
        module_key = metadata.get("moduleKey")
        workflow_stage = metadata.get("workflowStage")
        if asset.asset_type == "layout_plan" or str(metadata.get("jobType") or "") in {
            "LAYOUT",
            "LAYOUT_AI",
        }:
            module_key = "layout"
            workflow_stage = workflow_stage or "layout"
        elif asset.asset_type == "floorplan_analysis" or str(
            metadata.get("jobType") or ""
        ) == "FLOORPLAN_ANALYZE":
            module_key = "floorplan"

        for variant in variants:
            # 批准态必须按 variant：勿把资产级 approvalStatus 广播到每一张图
            variant_approved = bool(variant.get("approved"))
            nodes.append(
                {
                    "id": canvas_node_id(asset.id, variant["variantId"]),
                    **variant,
                    "jobId": asset.job_id,
                    "title": asset.title,
                    "assetType": asset.asset_type,
                    "generationMode": asset.generation_mode,
                    "moduleKey": module_key,
                    "workflowStage": workflow_stage,
                    "approvalStatus": "approved" if variant_approved else None,
                    "parentAssetId": asset.parent_asset_id,
                    "parentVariantId": parent_variant_id,
                    "createdAt": asset.created_at.isoformat()
                    if asset.created_at
                    else None,
                }
            )
        if asset.parent_asset_id:
            edges.append(
                {
                    "id": f"{asset.parent_asset_id}->{asset.id}",
                    "sourceAssetId": asset.parent_asset_id,
                    "sourceVariantId": parent_variant_id,
                    "targetAssetId": asset.id,
                }
            )

    # W0-f：收集 CANCELLED/FAILED job 的 partial outputs 作为临时节点
    partial_jobs = list(
        session.scalars(
            select(Job)
            .where(
                Job.project_id == project_id,
                Job.type.in_(ASSET_JOB_TYPES),
                Job.status.in_({"CANCELED", "FAILED"}),
            )
            .order_by(Job.created_at.asc())
        )
    )
    partial_nodes: list[dict[str, Any]] = []
    for job in partial_jobs:
        variants = expand_job_partial_outputs(job)
        if not variants:
            continue
        payload = _mapping(job.payload)
        parent_asset_id = payload.get("asset_parent_id")
        parent_variant_id = payload.get("parent_variant_id")
        for variant in variants:
            partial_nodes.append(
                {
                    "id": partial_node_id(job.id, variant["variantId"]),
                    **variant,
                    "title": f"{job.type}（{job.status}）",
                    "assetType": "partial_output",
                    "generationMode": "partial",
                    "moduleKey": None,
                    "workflowStage": None,
                    "approvalStatus": None,
                    "parentAssetId": parent_asset_id,
                    "parentVariantId": parent_variant_id,
                    "createdAt": job.created_at.isoformat() if job.created_at else None,
                    "isTemporary": True,
                    "jobStatus": job.status,
                }
            )
        if parent_asset_id:
            edges.append(
                {
                    "id": f"{parent_asset_id}~>{job.id}",
                    "sourceAssetId": parent_asset_id,
                    "sourceVariantId": parent_variant_id,
                    "targetJobId": job.id,
                }
            )

    return {
        "projectId": project_id,
        "assetCount": len(assets),
        "partialJobCount": len(partial_jobs),
        "nodeCount": len(nodes) + len(partial_nodes),
        "nodes": nodes + partial_nodes,
        "edges": edges,
        "includedOrphanAssets": included_orphans,
    }
