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

from app.assets import AI_WORKFLOW_JOB_TYPES
from app.models import SceneAsset


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
        approved = approved_variant_id is not None and variant_id == approved_variant_id
        return {
            "assetId": asset.id,
            "variantId": variant_id,
            "url": url,
            # 资产级 webp 缩略图只对代表图（fullUrl）存在；其余变体前端先用原图
            "thumbnailUrl": asset.thumbnail_url if url == full_url else None,
            "label": label or variant_id,
            "status": status,
            "approved": approved,
            "approvedVersionId": approved_version_id if approved else None,
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


def canvas_node_id(asset_id: str, variant_id: str) -> str:
    """画布节点身份：``{assetId}:{variantId}``。"""
    return f"{asset_id}:{variant_id}"


def build_project_canvas_graph(
    session: Session,
    project_id: str,
) -> dict[str, Any]:
    """组装项目画布图谱：逐图节点 + parent→child 派生连线（逻辑结构，不含坐标）。

    坐标与视口状态由 canvas_nodes / canvases 表（W0-d）承载；本图谱是
    只读事实层，前端落位时以节点 id 关联。
    """
    assets = list(
        session.scalars(
            select(SceneAsset)
            .where(SceneAsset.project_id == project_id)
            .order_by(SceneAsset.created_at.asc())
        )
    )
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    for asset in assets:
        metadata = _mapping(asset.metadata_json)
        variants = expand_asset_variants(asset)
        if not variants:
            continue
        parent_variant_id = metadata.get("parentVariantId")
        for variant in variants:
            nodes.append(
                {
                    "id": canvas_node_id(asset.id, variant["variantId"]),
                    **variant,
                    "jobId": asset.job_id,
                    "title": asset.title,
                    "assetType": asset.asset_type,
                    "generationMode": asset.generation_mode,
                    "moduleKey": metadata.get("moduleKey"),
                    "workflowStage": metadata.get("workflowStage"),
                    "approvalStatus": metadata.get("approvalStatus"),
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
    return {
        "projectId": project_id,
        "assetCount": len(assets),
        "nodeCount": len(nodes),
        "nodes": nodes,
        "edges": edges,
    }
