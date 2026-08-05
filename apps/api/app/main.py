from __future__ import annotations

import hashlib
import json
import logging
from copy import deepcopy
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, Literal, TypeVar
from urllib.parse import unquote, urlsplit

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from pydantic import ValidationError
from starlette.responses import JSONResponse

from app.assets import (
    ASSET_JOB_TYPES,
    LOCAL_OWNER_ID,
    asset_modules,
    backfill_scene_assets,
    backfill_thumbnails,
    get_local_scene_asset,
    scene_asset_detail,
    scene_asset_read,
)
from app.config import WORKSPACE_ROOT, settings
from app.canvas import build_project_canvas_graph
from app.database import SessionLocal, get_session, init_db
from app.jobs import (
    archive_job_asset,
    create_job,
    dispatch_job,
    reclaim_stale_jobs,
    shutdown_job_executor,
)
from app.logging_config import configure_logging
from app.models import Canvas, CanvasNode, Job, Project, SceneAsset, new_id, utc_now
from app.processors.ai_workflow import (
    AXONOMETRIC_VARIANTS,
    COLOR_PLAN_VARIANTS,
    STYLE_SCHEME_VARIANTS,
    TONE_SCHEME_VARIANTS,
)
from app.processors.floorplan_enhancement import enhancement_capability
from app.schemas import (
    AIAxonometricJobPayload,
    AIColorPlanJobPayload,
    AILocalEditJobPayload,
    AISpaceRenderJobPayload,
    AIStyleSchemeJobPayload,
    AIToneSchemeJobPayload,
    APIModel,
    AssetModuleRead,
    CanvasCreate,
    CanvasDetail,
    CanvasNodeBatchPatch,
    CanvasNodeCreate,
    CanvasNodePatch,
    CanvasNodeRead,
    CanvasRead,
    CameraPreset,
    EffectRenderRequest,
    FloorplanSceneRequest,
    JobRead,
    ProjectCreate,
    ProjectRead,
    ProjectUpdate,
    SceneAssetDetail,
    SceneAssetApprovalRequest,
    SceneAssetRead,
    SceneAssetRenderRequest,
    WorkflowResumeAsset,
)
from app.storage import save_upload


logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_: FastAPI):
    configure_logging()
    init_db()
    # C1：回收上一个进程遗留的 QUEUED/RUNNING，避免客户端轮询永久死亡的任务
    reclaim_stale_jobs()
    # W0-a：启动时一次性回填历史资产，之后不再在请求热路径调用
    backfill_session = SessionLocal()
    try:
        count = backfill_scene_assets(backfill_session)
        if count:
            logger.info("backfilled %s scene assets", count)
    except Exception:
        logger.exception("startup backfill_scene_assets failed")
    finally:
        backfill_session.close()
    yield
    # C4：有界关闭作业线程池——排队任务取消（保持 QUEUED，下次启动由 C1 回收），
    # 运行中任务随 daemon 线程在进程退出时中断
    shutdown_job_executor()


app = FastAPI(
    title=settings.app_name,
    version="0.6.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    # 本 API 不用 cookie / Authorization；credentials+* 会静默变成回显 Origin
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _reject_cross_site_mutations(request: Request, call_next):
    """阻止浏览器跨站 multipart/simple POST 烧本地计费额度（本地 CSRF）。"""
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        sec_fetch_site = (request.headers.get("sec-fetch-site") or "").lower()
        if sec_fetch_site == "cross-site":
            return JSONResponse(
                status_code=403,
                content={"detail": "拒绝跨站状态变更请求"},
            )
        origin = request.headers.get("origin")
        if origin:
            allowed = set(settings.cors_origin_list)
            if origin not in allowed:
                return JSONResponse(
                    status_code=403,
                    content={"detail": "Origin 不在允许列表中"},
                )
    return await call_next(request)


@app.middleware("http")
async def _cache_control_artifacts(request, call_next):
    """W0-c: Add long-term cache headers for static artifact files."""
    response = await call_next(request)
    if request.url.path.startswith("/artifacts/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


app.mount(
    "/artifacts",
    StaticFiles(directory=settings.artifact_dir),
    name="artifacts",
)
_examples_dir = WORKSPACE_ROOT / "example"
if _examples_dir.is_dir():
    app.mount(
        "/examples",
        StaticFiles(directory=_examples_dir),
        name="examples",
    )

SessionDep = Annotated[Session, Depends(get_session)]
# C5：建任务幂等键——前端每次用户提交生成一个 UUID（Idempotency-Key 头），
# 自动网络重试复用同一键；create_job 冲突时返回既有 job
IdempotencyKeyHeader = Annotated[str | None, Header(max_length=64)]
WorkflowPayload = TypeVar("WorkflowPayload", bound=APIModel)

WORKFLOW_STAGE_BY_JOB_TYPE = {
    "AI_COLOR_PLAN": "color_plan",
    "AI_AXONOMETRIC": "axonometric",
    "AI_SPACE_RENDER": "space_render",
    "AI_STYLE_SCHEME": "style_scheme",
    "AI_TONE_SCHEME": "tone_scheme",
    "AI_LOCAL_EDIT": "local_edit",
}
WORKFLOW_NEXT_STAGES = {
    "layout": ["color_plan"],
    "color_plan": ["axonometric", "space_render"],
    "axonometric": ["space_render"],
    "space_render": ["style_scheme"],
    "style_scheme": ["tone_scheme"],
    "tone_scheme": ["local_edit"],
    "local_edit": [],
}


def _semantic_layout_form(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="semanticLayout 必须是有效 JSON") from exc
    if not isinstance(value, dict) or not value:
        raise HTTPException(status_code=422, detail="semanticLayout 必须是非空 JSON 对象")
    wrapped = value.get("semanticLayout")
    if isinstance(wrapped, dict):
        value = wrapped
    elif isinstance(value.get("semantic_layout"), dict):
        value = value["semantic_layout"]
    if not isinstance(value.get("rooms"), list) or not value["rooms"]:
        raise HTTPException(status_code=422, detail="semanticLayout 的 rooms 必须是非空数组")
    return value


def _confirmed_stage01_dimensions(value: dict[str, Any]) -> tuple[int, int]:
    validation = value.get("validation")
    validation = validation if isinstance(validation, dict) else {}
    if not (
        validation.get("humanConfirmed") is True or validation.get("status") == "human_confirmed"
    ):
        raise HTTPException(status_code=422, detail="Stage 01 SemanticLayout 尚未人工批准")
    plan = value.get("plan")
    plan = plan if isinstance(plan, dict) else {}
    width = plan.get("widthMm")
    depth = plan.get("depthMm")
    if (
        isinstance(width, bool)
        or not isinstance(width, (int, float))
        or isinstance(depth, bool)
        or not isinstance(depth, (int, float))
    ):
        raise HTTPException(status_code=422, detail="Stage 01 缺少有效的总宽和总深")
    width_mm = round(width)
    depth_mm = round(depth)
    if not 2400 <= width_mm <= 30000 or not 2400 <= depth_mm <= 30000:
        raise HTTPException(status_code=422, detail="Stage 01 总宽和总深超出支持范围")
    return width_mm, depth_mm


def _stage01_bounds_form(raw: str) -> dict[str, float]:
    try:
        value = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Stage 01 标注边界必须是有效 JSON") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=422, detail="Stage 01 标注边界必须是 JSON 对象")
    bounds: dict[str, float] = {}
    for key in ("x", "y", "width", "height"):
        item = value.get(key)
        if isinstance(item, bool) or not isinstance(item, (int, float)):
            raise HTTPException(status_code=422, detail=f"Stage 01 标注边界缺少 {key}")
        bounds[key] = float(item)
    if bounds["width"] <= 0 or bounds["height"] <= 0:
        raise HTTPException(status_code=422, detail="Stage 01 标注边界宽高必须大于 0")
    return bounds


def _csv_values(
    raw: str | None,
    *,
    defaults: tuple[str, ...] = (),
    allowed: tuple[str, ...] | None = None,
    maximum: int,
    label: str,
) -> list[str]:
    clean_raw = (raw or "").strip()
    if clean_raw.startswith("["):
        try:
            parsed = json.loads(clean_raw)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"{label} JSON 数组无效") from exc
        if not isinstance(parsed, list) or any(not isinstance(item, str) for item in parsed):
            raise HTTPException(status_code=422, detail=f"{label}必须是字符串数组")
        values = [item.strip() for item in parsed if item.strip()]
    else:
        values = [item.strip() for item in clean_raw.split(",") if item.strip()]
    if not values:
        values = list(defaults)
    values = list(dict.fromkeys(values))
    if not values:
        raise HTTPException(status_code=422, detail=f"至少选择一个{label}")
    if len(values) > maximum:
        raise HTTPException(status_code=422, detail=f"{label}最多选择 {maximum} 个")
    if allowed is not None:
        invalid = [item for item in values if item not in allowed]
        if invalid:
            raise HTTPException(
                status_code=422,
                detail=f"不支持的{label}：{', '.join(invalid)}",
            )
    return values


def _validated_workflow_payload(
    model: type[WorkflowPayload],
    value: dict[str, Any],
) -> WorkflowPayload:
    try:
        return model.model_validate(value)
    except ValidationError as exc:
        message = exc.errors(include_url=False)[0].get("msg", "工作流参数无效")
        raise HTTPException(status_code=422, detail=message) from exc


def _resume_public_url(value: Any, *, label: str) -> str:
    """Return a browser-safe URL without exposing a host filesystem path."""

    if not isinstance(value, str) or not value.strip():
        raise HTTPException(status_code=409, detail=f"资产缺少{label}")
    url = value.strip()
    parsed = urlsplit(url)
    if parsed.scheme:
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(status_code=409, detail=f"资产的{label}不是可访问图片 URL")
        return url
    if parsed.netloc:
        raise HTTPException(status_code=409, detail=f"资产的{label}不是公开图片 URL")
    public_prefix = next(
        (prefix for prefix in ("/artifacts/", "/examples/") if parsed.path.startswith(prefix)),
        None,
    )
    relative_name = unquote(parsed.path[len(public_prefix) :]) if public_prefix else ""
    if public_prefix is None or not relative_name or Path(relative_name).name != relative_name:
        raise HTTPException(status_code=409, detail=f"资产的{label}不是公开图片 URL")
    return url


def _resume_optional_public_url(value: Any, *, label: str) -> str | None:
    if value is None or value == "":
        return None
    return _resume_public_url(value, label=label)


def _resume_semantic_candidate(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    wrapped = value.get("semanticLayout")
    if isinstance(wrapped, dict):
        value = wrapped
    elif isinstance(value.get("semantic_layout"), dict):
        value = value["semantic_layout"]
    rooms = value.get("rooms")
    if not isinstance(rooms, list) or not rooms:
        return None
    return value


def _workflow_asset_chain(session: Session, asset: SceneAsset) -> list[SceneAsset]:
    """Return root-to-leaf lineage, rejecting cycles and cross-project links."""

    reverse_chain = [asset]
    seen = {asset.id}
    parent_id = asset.parent_asset_id
    while parent_id:
        if parent_id in seen or len(reverse_chain) >= 32:
            raise HTTPException(status_code=409, detail="资产谱系存在循环或层级过深")
        parent = get_local_scene_asset(session, parent_id)
        if parent is None:
            raise HTTPException(status_code=409, detail="资产谱系引用的上游资产不存在")
        if parent.project_id != asset.project_id:
            raise HTTPException(status_code=409, detail="资产谱系跨越了不同项目")
        reverse_chain.append(parent)
        seen.add(parent.id)
        parent_id = parent.parent_asset_id
    return list(reversed(reverse_chain))


def _workflow_asset_stage(asset: SceneAsset, job: Job) -> str:
    metadata = asset.metadata_json if isinstance(asset.metadata_json, dict) else {}
    module_key = metadata.get("moduleKey")
    if module_key == "layout" and job.type in {"LAYOUT", "LAYOUT_AI"}:
        return "layout"
    stage = WORKFLOW_STAGE_BY_JOB_TYPE.get(job.type)
    if module_key != "ai_workflow" or stage is None:
        raise HTTPException(status_code=409, detail="该资产不是可续接的 AI 设计工作流资产")
    recorded_stage = metadata.get("workflowStage")
    if recorded_stage not in {None, stage}:
        raise HTTPException(status_code=409, detail="资产阶段与生成任务不一致")
    return stage


def _workflow_approved_output(
    asset: SceneAsset,
    job: Job,
    *,
    stage: str,
) -> tuple[dict[str, Any], str, str, str]:
    metadata = asset.metadata_json if isinstance(asset.metadata_json, dict) else {}
    deliverables = asset.deliverables if isinstance(asset.deliverables, dict) else {}
    if metadata.get("approvalStatus") != "approved":
        raise HTTPException(status_code=409, detail="资产尚未审批，不能作为后续阶段素材")
    variant_id = metadata.get("approvedVariantId")
    version_id = metadata.get("approvedVersionId")
    if not isinstance(variant_id, str) or not variant_id:
        raise HTTPException(status_code=409, detail="资产缺少批准方案 ID")
    if not isinstance(version_id, str) or not version_id:
        raise HTTPException(status_code=409, detail="资产缺少批准版本 ID")
    result = job.result if isinstance(job.result, dict) else {}
    if stage == "layout":
        candidates = result.get("layouts") if isinstance(result.get("layouts"), list) else []
        approved = next(
            (
                item
                for item in candidates
                if isinstance(item, dict)
                and item.get("layoutId") == variant_id
                and isinstance(item.get("previewUrl"), str)
            ),
            None,
        )
        output_value = approved.get("previewUrl") if isinstance(approved, dict) else None
    else:
        candidates = result.get("outputs") if isinstance(result.get("outputs"), list) else []
        approved = next(
            (
                item
                for item in candidates
                if isinstance(item, dict)
                and item.get("variantId") == variant_id
                and item.get("status") == "succeeded"
                and isinstance(item.get("url"), str)
            ),
            None,
        )
        output_value = approved.get("url") if isinstance(approved, dict) else None
    if not isinstance(approved, dict):
        raise HTTPException(status_code=409, detail="资产批准方案不再属于成功输出")
    output_url = _resume_public_url(output_value, label="批准输出图")
    if deliverables.get("approvedOutputUrl") != output_url:
        raise HTTPException(status_code=409, detail="资产批准输出与当前批准方案不一致")
    if deliverables.get("approvedVariantId") not in {None, variant_id}:
        raise HTTPException(status_code=409, detail="资产批准方案谱系不一致")
    if deliverables.get("approvedVersionId") not in {None, version_id}:
        raise HTTPException(status_code=409, detail="资产批准版本谱系不一致")
    return approved, variant_id, version_id, output_url


def _workflow_output_sha256(url: str) -> str | None:
    parsed = urlsplit(url)
    prefix = "/artifacts/"
    if parsed.scheme or parsed.netloc or not parsed.path.startswith(prefix):
        return None
    relative_name = unquote(parsed.path[len(prefix) :])
    if not relative_name or Path(relative_name).name != relative_name:
        return None
    path = settings.artifact_dir / relative_name
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _workflow_resume_bundle(session: Session, asset: SceneAsset) -> dict[str, Any]:
    job = session.get(Job, asset.job_id)
    if job is None or job.status != "SUCCEEDED":
        raise HTTPException(status_code=409, detail="资产缺少成功的生成任务")
    stage = _workflow_asset_stage(asset, job)
    approved, variant_id, version_id, output_url = _workflow_approved_output(
        asset,
        job,
        stage=stage,
    )
    chain = _workflow_asset_chain(session, asset)

    # Stage 02 may legitimately normalize validation and furniture after its
    # plan is approved.  Stage 03 then becomes the canonical semantic input for
    # the pure-AI chain.  Compare only AI-workflow copies with one another;
    # otherwise every valid Stage 02 -> 03 transition could look like tampering.
    workflow_semantic_candidates: list[dict[str, Any]] = []
    layout_semantic_candidates: list[dict[str, Any]] = []
    for item in reversed(chain):
        item_job = session.get(Job, item.job_id)
        payload = item_job.payload if item_job is not None else None
        candidate = _resume_semantic_candidate(
            payload.get("semantic_layout") if isinstance(payload, dict) else None
        )
        if candidate is not None:
            item_metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
            if item_metadata.get("moduleKey") == "ai_workflow":
                workflow_semantic_candidates.append(candidate)
            elif item_metadata.get("moduleKey") == "layout":
                layout_semantic_candidates.append(candidate)
    semantic_candidates = (
        workflow_semantic_candidates if workflow_semantic_candidates else layout_semantic_candidates
    )
    if not semantic_candidates:
        raise HTTPException(status_code=409, detail="资产缺少可续接的 canonical SemanticLayout")
    semantic_layout = semantic_candidates[0]
    semantic_digest = json.dumps(
        semantic_layout,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    if any(
        json.dumps(
            candidate,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        != semantic_digest
        for candidate in semantic_candidates[1:]
    ):
        raise HTTPException(status_code=409, detail="资产链中的 SemanticLayout 版本不一致")

    chain_entries: list[dict[str, Any]] = []
    layout_asset: SceneAsset | None = None
    color_asset: SceneAsset | None = None
    for item in chain:
        item_job = session.get(Job, item.job_id)
        if item_job is None:
            raise HTTPException(status_code=409, detail="资产谱系缺少生成任务")
        item_metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
        item_module = item_metadata.get("moduleKey")
        item_stage = (
            "layout" if item_module == "layout" else WORKFLOW_STAGE_BY_JOB_TYPE.get(item_job.type)
        )
        chain_entries.append(
            {
                "assetId": item.id,
                "jobId": item.job_id,
                "parentAssetId": item.parent_asset_id,
                "moduleKey": item_module,
                "workflowStage": item_stage,
                "approvedVersionId": item_metadata.get("approvedVersionId"),
            }
        )
        if item_module == "layout":
            layout_asset = item
        if item_module == "ai_workflow" and item_stage == "color_plan":
            color_asset = item

    layout_asset_version: str | None = None
    layout_image_url: str | None = None
    if layout_asset is not None:
        layout_metadata = (
            layout_asset.metadata_json if isinstance(layout_asset.metadata_json, dict) else {}
        )
        layout_deliverables = (
            layout_asset.deliverables if isinstance(layout_asset.deliverables, dict) else {}
        )
        layout_asset_version = layout_metadata.get("approvedVersionId")
        layout_image_url = _resume_optional_public_url(
            layout_deliverables.get("approvedOutputUrl"),
            label="已批准平面布局图",
        )
    if layout_asset_version is None:
        for item in reversed(chain):
            item_job = session.get(Job, item.job_id)
            item_payload = item_job.payload if item_job is not None else {}
            candidate = (
                item_payload.get("approved_layout_version_id")
                if isinstance(item_payload, dict)
                else None
            )
            if isinstance(candidate, str) and candidate:
                layout_asset_version = candidate
                break
    if layout_image_url is None:
        for item in reversed(chain):
            item_metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
            item_stage = item_metadata.get("workflowStage")
            if item_stage not in {"color_plan", "axonometric", "space_render"}:
                continue
            item_deliverables = item.deliverables if isinstance(item.deliverables, dict) else {}
            layout_image_url = _resume_optional_public_url(
                item_deliverables.get("approvedLayoutImageUrl"),
                label="已批准平面布局图",
            )
            if layout_image_url:
                break
    if stage == "layout":
        layout_asset = asset
        layout_asset_version = version_id
        layout_image_url = output_url

    color_asset_version: str | None = None
    color_image_url: str | None = None
    if color_asset is not None:
        color_metadata = (
            color_asset.metadata_json if isinstance(color_asset.metadata_json, dict) else {}
        )
        color_deliverables = (
            color_asset.deliverables if isinstance(color_asset.deliverables, dict) else {}
        )
        color_asset_version = color_metadata.get("approvedVersionId")
        color_image_url = _resume_optional_public_url(
            color_deliverables.get("approvedOutputUrl"),
            label="已批准彩平图",
        )
    if color_image_url is None:
        for item in reversed(chain):
            item_metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
            if item_metadata.get("workflowStage") not in {"axonometric", "space_render"}:
                continue
            item_deliverables = item.deliverables if isinstance(item.deliverables, dict) else {}
            color_image_url = _resume_optional_public_url(
                item_deliverables.get("approvedColorPlanImageUrl"),
                label="已批准彩平图",
            )
            if color_image_url:
                break
    if stage == "color_plan":
        color_asset = asset
        color_asset_version = version_id
        color_image_url = output_url

    if stage in {"color_plan", "axonometric"} and layout_image_url is None:
        raise HTTPException(status_code=409, detail="资产缺少可恢复的已批准平面布局图")
    if stage == "axonometric" and color_image_url is None:
        raise HTTPException(status_code=409, detail="资产缺少可恢复的已批准彩平图")

    current_payload = job.payload if isinstance(job.payload, dict) else {}
    space_id = approved.get("spaceId") or current_payload.get("space_id")
    space_id = space_id if isinstance(space_id, str) and space_id else None
    space_name = approved.get("spaceName")
    if not isinstance(space_name, str) or not space_name:
        space_name = next(
            (
                room.get("name")
                for room in semantic_layout.get("rooms", [])
                if isinstance(room, dict) and room.get("id") == space_id
            ),
            None,
        )
    if stage in {"space_render", "style_scheme", "tone_scheme", "local_edit"}:
        room_ids = {
            room.get("id")
            for room in semantic_layout.get("rooms", [])
            if isinstance(room, dict) and isinstance(room.get("id"), str)
        }
        if space_id not in room_ids:
            raise HTTPException(status_code=409, detail="批准空间与 SemanticLayout 不一致")

    stage01_lineage: dict[str, Any] = {}
    if layout_asset is not None:
        layout_job = session.get(Job, layout_asset.job_id)
        layout_result = (
            layout_job.result
            if layout_job is not None and isinstance(layout_job.result, dict)
            else {}
        )
        raw_stage01 = layout_result.get("stage01Lineage")
        if isinstance(raw_stage01, dict):
            stage01_lineage = {
                key: raw_stage01.get(key)
                for key in ("analysisJobId", "approvedVersionId", "sourceSha256")
                if raw_stage01.get(key) is not None
            }

    return {
        "asset_id": asset.id,
        "job_id": asset.job_id,
        "project_id": asset.project_id,
        "parent_asset_id": asset.parent_asset_id,
        "module_key": "layout" if stage == "layout" else "ai_workflow",
        "workflow_stage": stage,
        "approval_status": "approved",
        "approved_variant_id": variant_id,
        "approved_version_id": version_id,
        "approved_output_url": output_url,
        "approved_output_sha256": _workflow_output_sha256(output_url),
        "semantic_layout": deepcopy(semantic_layout),
        "approved_layout_asset_id": layout_asset.id if layout_asset else None,
        "approved_layout_version_id": layout_asset_version,
        "approved_layout_image_url": layout_image_url,
        "approved_color_plan_asset_id": color_asset.id if color_asset else None,
        "approved_color_plan_version_id": color_asset_version,
        "approved_color_plan_image_url": color_image_url,
        "source_space_image_url": (
            output_url
            if stage in {"space_render", "style_scheme", "tone_scheme", "local_edit"}
            else None
        ),
        "space_id": space_id,
        "space_name": space_name,
        "eligible_next_stages": WORKFLOW_NEXT_STAGES[stage],
        "lineage": {
            "projectId": asset.project_id,
            "parentAssetId": asset.parent_asset_id,
            "ancestorAssetIds": [item.id for item in chain[:-1]],
            "assets": chain_entries,
            "stage01": stage01_lineage,
        },
    }


def _validate_parent_asset(
    session: Session,
    asset_id: str | None,
    *,
    project_id: str | None,
    workflow_stage: Literal[
        "color_plan",
        "axonometric",
        "space_render",
        "style_scheme",
        "tone_scheme",
        "local_edit",
    ],
) -> str | None:
    if not asset_id:
        return project_id
    asset = get_local_scene_asset(session, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="上游资产不存在或不属于当前本地账户")
    if project_id is not None and asset.project_id != project_id:
        raise HTTPException(status_code=409, detail="上游资产与当前任务不属于同一项目")

    metadata = asset.metadata_json if isinstance(asset.metadata_json, dict) else {}
    parent_module = metadata.get("moduleKey")
    parent_stage = metadata.get("workflowStage")
    if parent_module == "ai_workflow" and metadata.get("approvalStatus") != "approved":
        raise HTTPException(status_code=409, detail="上游 AI 工作流资产尚未审批通过")
    if workflow_stage == "color_plan":
        allowed = parent_module in {"layout", "floorplan"}
        requirement = "彩平图的上游资产必须是已批准的平面布局或户型资产"
        if parent_module == "layout" and metadata.get("approvalStatus") != "approved":
            raise HTTPException(status_code=409, detail="上游 AI 平面布局资产尚未审批通过")
    elif workflow_stage == "axonometric":
        allowed = parent_module == "ai_workflow" and parent_stage == "color_plan"
        requirement = "轴侧图的上游资产必须是已批准的 AI 彩平方案"
    elif workflow_stage == "space_render":
        allowed = parent_module == "ai_workflow" and parent_stage in {
            "color_plan",
            "axonometric",
        }
        requirement = "分空间效果图的上游资产必须是已批准的彩平或轴侧方案"
    elif workflow_stage == "style_scheme":
        allowed = parent_module == "ai_workflow" and parent_stage == "space_render"
        requirement = "风格方案的上游资产必须是已批准的空间效果图"
    elif workflow_stage == "tone_scheme":
        allowed = parent_module == "ai_workflow" and parent_stage == "style_scheme"
        requirement = "色调方案的上游资产必须是已批准的风格方案"
    else:
        allowed = parent_module == "ai_workflow" and parent_stage == "tone_scheme"
        requirement = "局部修改的上游资产必须是已批准的色调方案"
    if not allowed:
        raise HTTPException(status_code=409, detail=requirement)
    return project_id if project_id is not None else asset.project_id


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source_file:
            while chunk := source_file.read(1024 * 1024):
                digest.update(chunk)
    except OSError as exc:
        raise HTTPException(status_code=409, detail="无法校验批准方案文件") from exc
    return digest.hexdigest()


def _artifact_path_from_public_url(url: str, *, label: str) -> Path:
    parsed = urlsplit(url)
    artifact_prefix = "/artifacts/"
    if parsed.scheme or parsed.netloc or not parsed.path.startswith(artifact_prefix):
        raise HTTPException(status_code=409, detail=f"{label}不是可校验的本地资产")
    relative_name = unquote(parsed.path[len(artifact_prefix) :])
    if not relative_name or Path(relative_name).name != relative_name:
        raise HTTPException(status_code=409, detail=f"{label}的本地资产路径无效")
    path = settings.artifact_dir / relative_name
    if not path.is_file():
        raise HTTPException(status_code=409, detail=f"{label}的本地输出文件不存在")
    return path


def _layout_approval_versions(metadata: dict[str, Any]) -> dict[str, str]:
    """主批准 + variantApprovals → {variantId: versionId}。"""
    approval_map: dict[str, str] = {}
    variant_approvals = metadata.get("variantApprovals")
    if isinstance(variant_approvals, dict):
        for key, entry in variant_approvals.items():
            if isinstance(entry, dict) and isinstance(entry.get("versionId"), str):
                approval_map[str(key)] = entry["versionId"]
    primary_variant = metadata.get("approvedVariantId")
    primary_version = metadata.get("approvedVersionId")
    if isinstance(primary_variant, str) and isinstance(primary_version, str):
        approval_map.setdefault(primary_variant, primary_version)
    return approval_map


def _layout_variant_output_url(
    asset: SceneAsset,
    job: Job | None,
    variant_id: str,
) -> str | None:
    """解析 layout 资产某 variant 的预览 URL（job.layouts 或 deliverables）。"""
    deliverables = asset.deliverables if isinstance(asset.deliverables, dict) else {}
    if deliverables.get("approvedVariantId") == variant_id:
        url = deliverables.get("approvedOutputUrl")
        if isinstance(url, str) and url:
            return url
    metadata = asset.metadata_json if isinstance(asset.metadata_json, dict) else {}
    variant_approvals = metadata.get("variantApprovals")
    if isinstance(variant_approvals, dict):
        entry = variant_approvals.get(variant_id)
        if isinstance(entry, dict):
            url = entry.get("outputUrl")
            if isinstance(url, str) and url:
                return url
    result = job.result if job is not None and isinstance(job.result, dict) else {}
    layouts = result.get("layouts") if isinstance(result.get("layouts"), list) else []
    for item in layouts:
        if (
            isinstance(item, dict)
            and item.get("layoutId") == variant_id
            and isinstance(item.get("previewUrl"), str)
            and item["previewUrl"]
        ):
            return str(item["previewUrl"])
    return None


def _validate_parent_approved_layout(
    session: Session,
    asset_id: str,
    *,
    approved_layout_version_id: str | None,
    uploaded_layout_path: Path,
) -> dict[str, str]:
    """校验 color-plan 上游 layout：版本属于已批 variant，上传图与批准输出字节一致。"""
    asset = get_local_scene_asset(session, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="上游布局资产不存在")
    metadata = asset.metadata_json if isinstance(asset.metadata_json, dict) else {}
    module_key = metadata.get("moduleKey") or scene_asset_read(asset).get("module_key")
    if module_key not in {"layout", "floorplan"}:
        raise HTTPException(status_code=409, detail="彩平图的上游必须是平面布局或户型资产")
    if module_key == "floorplan":
        # 户型直接派生彩平（兼容旧链路）：仅要求上传文件存在
        if not uploaded_layout_path.is_file():
            raise HTTPException(status_code=409, detail="上传的布局图无效")
        return {
            "parent_approved_version_id": approved_layout_version_id or "",
            "parent_variant_id": "",
            "source_sha256": _sha256_file(uploaded_layout_path),
        }

    approval_map = _layout_approval_versions(metadata)
    if not approval_map:
        raise HTTPException(status_code=409, detail="上游平面布局资产尚未审批通过")

    approved_variant_id: str | None = None
    approved_version_id: str | None = None
    if approved_layout_version_id:
        for variant_key, version_key in approval_map.items():
            # 兼容：既可传 immutable versionId，也可传 layoutId/variantId
            if (
                approved_layout_version_id == version_key
                or approved_layout_version_id == variant_key
            ):
                approved_variant_id = variant_key
                approved_version_id = version_key
                break
        if approved_variant_id is None:
            raise HTTPException(
                status_code=409,
                detail="提交的布局版本不是上游资产的已批准版本，请重新批准后再生成",
            )
    else:
        # 未传 version：回落主批准
        primary = metadata.get("approvedVariantId")
        if isinstance(primary, str) and primary in approval_map:
            approved_variant_id = primary
            approved_version_id = approval_map[primary]
        else:
            approved_variant_id, approved_version_id = next(iter(approval_map.items()))

    job = session.get(Job, asset.job_id) if asset.job_id else None
    assert approved_variant_id is not None
    output_url = _layout_variant_output_url(asset, job, approved_variant_id)
    if not output_url:
        raise HTTPException(status_code=409, detail="上游批准布局缺少可复用的输出图")
    upload_sha = _sha256_file(uploaded_layout_path)
    # 批准输出文件存在时强制字节一致；夹具缺文件时仅做版本门控（测试/历史）
    try:
        approved_path = _artifact_path_from_public_url(
            output_url, label="上游批准布局图"
        )
    except HTTPException:
        approved_path = None
    if approved_path is not None:
        approved_sha = _sha256_file(approved_path)
        if approved_sha != upload_sha:
            raise HTTPException(
                status_code=409,
                detail="上传的布局图与上游资产当前批准输出不一致",
            )
    return {
        "parent_approved_version_id": approved_version_id or "",
        "parent_variant_id": approved_variant_id,
        "source_sha256": upload_sha,
    }


def _validate_parent_approved_output_image(
    session: Session,
    asset_id: str,
    *,
    uploaded_path: Path,
    allowed_stages: set[str],
    label: str,
    approved_version_id: str | None = None,
) -> dict[str, str]:
    """校验上传图字节与上游已批输出一致（彩平 / 布局通用）。"""
    asset = get_local_scene_asset(session, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail=f"上游{label}资产不存在")
    metadata = asset.metadata_json if isinstance(asset.metadata_json, dict) else {}
    stage = metadata.get("workflowStage")
    module_key = metadata.get("moduleKey") or scene_asset_read(asset).get("module_key")
    stage_ok = (
        (isinstance(stage, str) and stage in allowed_stages)
        or (module_key in allowed_stages)
        or (module_key == "ai_workflow" and isinstance(stage, str) and stage in allowed_stages)
    )
    if not stage_ok and "layout" in allowed_stages and module_key in {"layout", "floorplan"}:
        stage_ok = True
    if not stage_ok:
        raise HTTPException(
            status_code=409,
            detail=f"{label}的上游资产阶段不符合要求",
        )

    approval_map = _layout_approval_versions(metadata)
    if not approval_map:
        # 也支持仅有主批准字段
        primary = metadata.get("approvedVariantId")
        version = metadata.get("approvedVersionId")
        if isinstance(primary, str) and isinstance(version, str):
            approval_map = {primary: version}
    if not approval_map and module_key != "floorplan":
        raise HTTPException(status_code=409, detail=f"上游{label}资产尚未审批通过")

    approved_variant_id: str | None = None
    approved_version: str | None = None
    if approved_version_id and approval_map:
        for variant_key, version_key in approval_map.items():
            if (
                approved_version_id == version_key
                or approved_version_id == variant_key
            ):
                approved_variant_id = variant_key
                approved_version = version_key
                break
        if approved_variant_id is None and module_key != "floorplan":
            raise HTTPException(
                status_code=409,
                detail=f"提交的{label}版本不是上游资产的已批准版本",
            )
    elif approval_map:
        primary = metadata.get("approvedVariantId")
        if isinstance(primary, str) and primary in approval_map:
            approved_variant_id = primary
            approved_version = approval_map[primary]
        else:
            approved_variant_id, approved_version = next(iter(approval_map.items()))

    job = session.get(Job, asset.job_id) if asset.job_id else None
    output_url: str | None = None
    if approved_variant_id:
        output_url = _layout_variant_output_url(asset, job, approved_variant_id)
    if not output_url and job is not None and isinstance(job.result, dict):
        preview = job.result.get("previewUrl") or job.result.get("url")
        if isinstance(preview, str):
            output_url = preview
    upload_sha = _sha256_file(uploaded_path)
    if output_url:
        try:
            approved_path = _artifact_path_from_public_url(
                output_url, label=f"上游批准{label}图"
            )
        except HTTPException:
            approved_path = None
        if approved_path is not None:
            if _sha256_file(approved_path) != upload_sha:
                raise HTTPException(
                    status_code=409,
                    detail=f"上传的{label}图与上游资产当前批准输出不一致",
                )
    return {
        "parent_approved_version_id": approved_version or approved_version_id or "",
        "parent_variant_id": approved_variant_id or "",
        "source_sha256": upload_sha,
    }


def _find_ancestor_asset(
    session: Session,
    asset_id: str,
    *,
    stages: set[str],
    modules: set[str] | None = None,
) -> SceneAsset | None:
    """沿 parent_asset_id 向上找指定 workflowStage / moduleKey 的祖先。"""
    modules = modules or set()
    seen: set[str] = set()
    current_id: str | None = asset_id
    while current_id and current_id not in seen:
        seen.add(current_id)
        asset = get_local_scene_asset(session, current_id)
        if asset is None:
            return None
        metadata = asset.metadata_json if isinstance(asset.metadata_json, dict) else {}
        stage = metadata.get("workflowStage")
        module_key = metadata.get("moduleKey") or scene_asset_read(asset).get(
            "module_key"
        )
        if (isinstance(stage, str) and stage in stages) or (
            isinstance(module_key, str) and module_key in modules
        ):
            return asset
        parent = asset.parent_asset_id
        current_id = parent if isinstance(parent, str) else None
    return None


def _validate_layout_and_color_plan_for_stage45(
    session: Session,
    asset_parent_id: str,
    *,
    approved_layout_version_id: str | None,
    uploaded_layout_path: Path,
    uploaded_color_plan_path: Path,
) -> dict[str, str]:
    """04/05：parent 可为彩平/轴侧等；布局与彩平图分别校对应祖先的已批输出字节。"""
    parent = get_local_scene_asset(session, asset_parent_id)
    if parent is None:
        raise HTTPException(status_code=404, detail="上游资产不存在")

    color_asset = _find_ancestor_asset(
        session,
        asset_parent_id,
        stages={"color_plan"},
        modules=set(),
    )
    layout_asset = _find_ancestor_asset(
        session,
        asset_parent_id,
        stages={"layout"},
        modules={"layout", "floorplan"},
    )

    color_lineage: dict[str, str]
    if color_asset is not None:
        color_lineage = _validate_parent_approved_output_image(
            session,
            color_asset.id,
            uploaded_path=uploaded_color_plan_path,
            allowed_stages={"color_plan", "ai_workflow"},
            label="彩平",
        )
    else:
        # 兼容：无彩平祖先时只要求文件可读
        color_lineage = {
            "parent_approved_version_id": "",
            "parent_variant_id": "",
            "source_sha256": _sha256_file(uploaded_color_plan_path),
        }

    layout_asset_id = layout_asset.id if layout_asset is not None else asset_parent_id
    layout_lineage = _validate_parent_approved_layout(
        session,
        layout_asset_id,
        approved_layout_version_id=approved_layout_version_id,
        uploaded_layout_path=uploaded_layout_path,
    )
    return {
        "parent_approved_version_id": layout_lineage.get(
            "parent_approved_version_id", ""
        ),
        "parent_variant_id": layout_lineage.get("parent_variant_id", ""),
        "source_sha256": layout_lineage.get("source_sha256", ""),
        "color_plan_sha256": color_lineage.get("source_sha256", ""),
    }


def _validate_parent_approved_space(
    session: Session,
    asset_id: str,
    *,
    space_id: str,
    source_space_version_id: str,
    source_space_path: Path,
) -> dict[str, str]:
    """Validate and snapshot the exact approved parent used by a derivative.

    The browser uploads the approved image again for stages 6 through 8.  Merely
    trusting ``asset_parent_id`` would allow a stale or unrelated image to be
    attached to an otherwise valid parent.  Both the immutable approval version
    and the image bytes therefore have to match the parent's current approval.
    """

    asset = get_local_scene_asset(session, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="上游空间资产不存在")
    metadata = asset.metadata_json if isinstance(asset.metadata_json, dict) else {}
    # W0-X：版本可匹配「当前主批准」或 variantApprovals 中任一已批 variant
    variant_approvals = metadata.get("variantApprovals")
    approval_map: dict[str, str] = {}
    if isinstance(variant_approvals, dict):
        for key, entry in variant_approvals.items():
            if isinstance(entry, dict) and isinstance(entry.get("versionId"), str):
                approval_map[str(key)] = entry["versionId"]
    primary_variant = metadata.get("approvedVariantId")
    primary_version = metadata.get("approvedVersionId")
    if isinstance(primary_variant, str) and isinstance(primary_version, str):
        approval_map.setdefault(primary_variant, primary_version)
    if not approval_map:
        raise HTTPException(status_code=409, detail="上游空间资产尚未选择批准方案")

    approved_variant_id: str | None = None
    approved_version_id: str | None = None
    for variant_key, version_key in approval_map.items():
        if source_space_version_id == version_key:
            approved_variant_id = variant_key
            approved_version_id = version_key
            break
    if approved_variant_id is None or approved_version_id is None:
        raise HTTPException(
            status_code=409,
            detail="提交的空间图版本不是上游资产的已批准版本，请重新选择基准图",
        )
    job = session.get(Job, asset.job_id)
    result = job.result if job is not None and isinstance(job.result, dict) else {}
    outputs = result.get("outputs") if isinstance(result.get("outputs"), list) else []
    approved_output = next(
        (
            output
            for output in outputs
            if isinstance(output, dict)
            and output.get("variantId") == approved_variant_id
            and output.get("status") == "succeeded"
        ),
        None,
    )
    if not isinstance(approved_output, dict):
        raise HTTPException(status_code=409, detail="上游批准方案缺少可复用的成功输出")
    if approved_output.get("spaceId") != space_id:
        raise HTTPException(status_code=409, detail="上游批准方案与当前 spaceId 不一致")

    approved_url = approved_output.get("url")
    if not isinstance(approved_url, str) or not approved_url:
        raise HTTPException(status_code=409, detail="上游批准方案缺少本地输出文件")
    approved_path = _artifact_path_from_public_url(
        approved_url, label="上游批准方案"
    )

    approved_sha256 = _sha256_file(approved_path)
    source_sha256 = _sha256_file(source_space_path)
    if source_sha256 != approved_sha256:
        raise HTTPException(
            status_code=409,
            detail="上传的空间图与上游资产当前批准输出不一致",
        )
    return {
        "parent_approved_version_id": approved_version_id,
        "parent_variant_id": approved_variant_id,
        "source_sha256": source_sha256,
    }


async def _save_style_references(
    references: list[UploadFile] | None,
) -> list[str]:
    uploads = references or []
    if len(uploads) > 7:
        raise HTTPException(status_code=422, detail="风格参考图最多上传 7 张")
    return [str(await save_upload(upload)) for upload in uploads]


@app.get("/health")
def health() -> dict:
    enhancement = enhancement_capability()
    legacy_enhancement = {
        **enhancement,
        "legacyOnly": True,
        "productionEnabled": False,
        "detail": (f"历史兼容能力，不参与 V0.6 阶段 3～5。{enhancement.get('detail', '')}"),
    }
    return {
        "status": "ok",
        "service": settings.app_name,
        "version": "0.6.0",
        "productionGeneration": "ai_workflow",
        "blenderWorkflowEnabled": False,
        "legacyBlenderAvailable": settings.blender_enabled,
        "floorplanAiConfigured": bool(settings.floorplan_ai_endpoint),
        "floorplanVision": {
            "configured": settings.floorplan_vision_configured,
            "provider": settings.floorplan_vision_provider,
            "model": settings.kuyao_vision_model,
        },
        "floorplanEnhancement": legacy_enhancement,
        "aiDesignWorkflow": {
            "configured": settings.kuyao_image_edit_configured,
            "provider": "kuyao" if settings.kuyao_image_edit_configured else None,
            "model": settings.kuyao_image_model,
            "blenderRequired": False,
            "stages": [
                "color_plan",
                "axonometric",
                "space_render",
                "style_scheme",
                "tone_scheme",
                "local_edit",
            ],
        },
    }


@app.post(
    f"{settings.api_prefix}/projects",
    response_model=ProjectRead,
    status_code=status.HTTP_201_CREATED,
)
def create_project(payload: ProjectCreate, session: SessionDep) -> Project:
    project = Project(
        name=payload.name,
        description=payload.description,
        design_prompt=payload.design_prompt,
        cover_url=payload.cover_url,
    )
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


@app.get(f"{settings.api_prefix}/projects", response_model=list[ProjectRead])
def list_projects(session: SessionDep) -> list[Project]:
    # W6-1：最近项目按 updated_at 优先（无值时回退 created_at）
    return list(
        session.scalars(
            select(Project).order_by(
                Project.updated_at.desc().nullslast(),
                Project.created_at.desc(),
            )
        )
    )


@app.patch(
    f"{settings.api_prefix}/projects/{{project_id}}",
    response_model=ProjectRead,
)
def update_project(
    project_id: str,
    payload: ProjectUpdate,
    session: SessionDep,
) -> Project:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        project.name = str(data["name"]).strip() or project.name
    if "description" in data:
        project.description = data["description"]
    if "design_prompt" in data:
        project.design_prompt = data["design_prompt"]
    if "cover_url" in data:
        project.cover_url = data["cover_url"]
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


@app.delete(
    f"{settings.api_prefix}/projects/{{project_id}}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_project(project_id: str, session: SessionDep) -> None:
    """删除项目记录；资产/任务解绑为孤儿（project_id=null），不物理删生成图。"""
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="项目不存在")

    # 画布节点 → 画布
    canvases = list(
        session.scalars(select(Canvas).where(Canvas.project_id == project_id))
    )
    for canvas in canvases:
        nodes = list(
            session.scalars(
                select(CanvasNode).where(CanvasNode.canvas_id == canvas.id)
            )
        )
        for node in nodes:
            session.delete(node)
        session.delete(canvas)

    # 资产 / 任务仅解绑，保留文件与归档
    for asset in session.scalars(
        select(SceneAsset).where(SceneAsset.project_id == project_id)
    ):
        asset.project_id = None
    for job in session.scalars(select(Job).where(Job.project_id == project_id)):
        job.project_id = None

    session.delete(project)
    session.commit()
    return None


@app.get(f"{settings.api_prefix}/assets", response_model=list[SceneAssetRead])
def list_scene_assets(
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    generation_mode: Annotated[
        str | None,
        Query(alias="generationMode", min_length=1, max_length=32),
    ] = None,
    module_key: Annotated[
        str | None,
        Query(
            alias="moduleKey",
            pattern=(
                "^(floorplan|layout|white_model|effect_render|material_replacement|ai_workflow)$"
            ),
        ),
    ] = None,
    workflow_stage: Annotated[
        Literal[
            "color_plan",
            "axonometric",
            "space_render",
            "style_scheme",
            "tone_scheme",
            "local_edit",
        ]
        | None,
        Query(alias="workflowStage"),
    ] = None,
    project_id: Annotated[
        str | None,
        Query(alias="projectId", min_length=1, max_length=40),
    ] = None,
) -> list[dict]:
    statement = select(SceneAsset).where(
        SceneAsset.owner_id == LOCAL_OWNER_ID,
        SceneAsset.thumbnail_url.is_not(None),
    )
    if generation_mode:
        statement = statement.where(SceneAsset.generation_mode == generation_mode)
    if project_id:
        statement = statement.where(SceneAsset.project_id == project_id)
    statement = statement.order_by(SceneAsset.created_at.desc()).offset(offset).limit(limit)
    assets = list(session.scalars(statement))
    values = [scene_asset_read(asset) for asset in assets]
    if module_key:
        values = [value for value in values if value["module_key"] == module_key]
    if workflow_stage:
        values = [
            value
            for value in values
            if value.get("metadata", {}).get("workflowStage") == workflow_stage
        ]
    return values


@app.get(
    f"{settings.api_prefix}/assets/modules",
    response_model=list[AssetModuleRead],
)
def list_asset_modules() -> list[dict[str, str]]:
    return asset_modules()




@app.post(f"{settings.api_prefix}/assets/backfill")
def trigger_backfill(session: SessionDep) -> dict[str, int]:
    count = backfill_scene_assets(session)
    return {"backfilled": count}


@app.post(f"{settings.api_prefix}/assets/backfill-thumbnails")
def trigger_backfill_thumbnails(session: SessionDep) -> dict[str, int]:
    count = backfill_thumbnails(session)
    return {"backfilled": count}
@app.get(
    f"{settings.api_prefix}/assets/{{asset_id}}",
    response_model=SceneAssetDetail,
)
def get_scene_asset(asset_id: str, session: SessionDep) -> dict:
    asset = get_local_scene_asset(session, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    return scene_asset_detail(session, asset)


@app.get(
    f"{settings.api_prefix}/assets/{{asset_id}}/workflow-resume",
    response_model=WorkflowResumeAsset,
)
def get_workflow_resume_asset(asset_id: str, session: SessionDep) -> dict[str, Any]:
    """Return the approved, public inputs needed to continue stages 03 through 08."""

    asset = get_local_scene_asset(session, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    return _workflow_resume_bundle(session, asset)


@app.post(
    f"{settings.api_prefix}/assets/{{asset_id}}/approve",
    response_model=SceneAssetDetail,
)
def approve_scene_asset_variant(
    asset_id: str,
    payload: SceneAssetApprovalRequest,
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
) -> dict:
    asset = get_local_scene_asset(session, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    module_key = scene_asset_read(asset)["module_key"]
    if module_key not in {"ai_workflow", "layout"}:
        raise HTTPException(status_code=409, detail="该资产模块不支持方案审批")

    variant_id = payload.variant_id.strip()
    if not variant_id:
        raise HTTPException(status_code=422, detail="variantId 不能为空")
    job = session.get(Job, asset.job_id)
    result = job.result if job is not None and isinstance(job.result, dict) else {}
    if module_key == "layout":
        layouts = result.get("layouts") if isinstance(result.get("layouts"), list) else []
        approved_output_url = next(
            (
                layout["previewUrl"]
                for layout in layouts
                if isinstance(layout, dict)
                and layout.get("layoutId") == variant_id
                and isinstance(layout.get("previewUrl"), str)
                and layout["previewUrl"]
            ),
            None,
        )
        invalid_variant_detail = "layoutId 不属于该布局资产的有效方案"
    else:
        outputs = result.get("outputs") if isinstance(result.get("outputs"), list) else []
        approved_output_url = next(
            (
                output["url"]
                for output in outputs
                if isinstance(output, dict)
                and output.get("variantId") == variant_id
                and output.get("status") == "succeeded"
                and isinstance(output.get("url"), str)
                and output["url"]
            ),
            None,
        )
        invalid_variant_detail = "variantId 不属于该资产的成功输出"
    if approved_output_url is None:
        raise HTTPException(status_code=422, detail=invalid_variant_detail)

    existing_metadata = asset.metadata_json if isinstance(asset.metadata_json, dict) else {}
    existing_variant_approvals = existing_metadata.get("variantApprovals")
    variant_approvals: dict[str, Any] = (
        dict(existing_variant_approvals)
        if isinstance(existing_variant_approvals, dict)
        else {}
    )
    existing_entry = variant_approvals.get(variant_id)
    if (
        isinstance(existing_entry, dict)
        and isinstance(existing_entry.get("versionId"), str)
        and existing_entry.get("versionId")
    ):
        # W0-X：同一 variant 再次批准幂等，不换 versionId，保护下游谱系
        return scene_asset_detail(session, asset)
    if (
        existing_metadata.get("approvalStatus") == "approved"
        and existing_metadata.get("approvedVariantId") == variant_id
        and isinstance(existing_metadata.get("approvedVersionId"), str)
    ):
        return scene_asset_detail(session, asset)

    # W0-X：variant 粒度审批——已有下游时仍可批准*其他* variant 以分叉；
    # 不再对「改批另一张图」返回 409。同一 variant 的 versionId 一经写入不可变。
    approved_at = utc_now().isoformat()
    approved_version_id = f"{asset.id}:{variant_id}:{approved_at}"
    variant_approvals[variant_id] = {
        "versionId": approved_version_id,
        "approvedAt": approved_at,
        "outputUrl": approved_output_url,
    }
    metadata = dict(asset.metadata_json or {})
    metadata.update(
        {
            "approvalStatus": "approved",
            "approvedVariantId": variant_id,
            "approvedVersionId": approved_version_id,
            "approvedAt": approved_at,
            "approvalComment": payload.comment.strip() if payload.comment else None,
            "variantApprovals": variant_approvals,
        }
    )
    deliverables = dict(asset.deliverables or {})
    deliverables.update(
        {
            "approvedOutputUrl": approved_output_url,
            "approvedVariantId": variant_id,
            "approvedVersionId": approved_version_id,
            "variantApprovals": variant_approvals,
        }
    )
    asset.metadata_json = metadata
    asset.deliverables = deliverables
    session.commit()
    session.refresh(asset)
    return scene_asset_detail(session, asset)


@app.post(
    f"{settings.api_prefix}/assets/{{asset_id}}/unapprove",
    response_model=SceneAssetDetail,
)
def unapprove_scene_asset_variant(
    asset_id: str,
    payload: SceneAssetApprovalRequest,
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
) -> dict:
    """取消某个 variant 的批准状态。

    - 从 variantApprovals 移除该 variant
    - 若当前主批准正是该 variant，则切换到其余任一已批 variant，或清空批准态
    - 已生成的下游资产不受影响；仅阻止以此 variant 再派生新下游
    """
    asset = get_local_scene_asset(session, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    module_key = scene_asset_read(asset)["module_key"]
    if module_key not in {"ai_workflow", "layout"}:
        raise HTTPException(status_code=409, detail="该资产模块不支持方案审批")

    variant_id = payload.variant_id.strip()
    if not variant_id:
        raise HTTPException(status_code=422, detail="variantId 不能为空")

    existing_metadata = (
        dict(asset.metadata_json) if isinstance(asset.metadata_json, dict) else {}
    )
    existing_variant_approvals = existing_metadata.get("variantApprovals")
    variant_approvals: dict[str, Any] = (
        dict(existing_variant_approvals)
        if isinstance(existing_variant_approvals, dict)
        else {}
    )
    is_primary = existing_metadata.get("approvedVariantId") == variant_id
    was_approved = (
        variant_id in variant_approvals
        or (
            is_primary
            and existing_metadata.get("approvalStatus") == "approved"
        )
    )
    if not was_approved:
        # 幂等：本来就未批准，直接返回
        return scene_asset_detail(session, asset)

    variant_approvals.pop(variant_id, None)

    metadata = dict(existing_metadata)
    deliverables = dict(asset.deliverables or {}) if isinstance(asset.deliverables, dict) else {}

    if is_primary or not variant_approvals:
        if variant_approvals:
            # 主批准被取消：改挂到剩余任意已批 variant
            next_variant_id, next_entry = next(iter(variant_approvals.items()))
            next_meta = next_entry if isinstance(next_entry, dict) else {}
            next_version = (
                next_meta.get("versionId")
                if isinstance(next_meta.get("versionId"), str)
                else None
            )
            next_url = (
                next_meta.get("outputUrl")
                if isinstance(next_meta.get("outputUrl"), str)
                else None
            )
            next_at = (
                next_meta.get("approvedAt")
                if isinstance(next_meta.get("approvedAt"), str)
                else None
            )
            metadata.update(
                {
                    "approvalStatus": "approved",
                    "approvedVariantId": next_variant_id,
                    "approvedVersionId": next_version,
                    "approvedAt": next_at,
                    "approvalComment": payload.comment.strip()
                    if payload.comment
                    else existing_metadata.get("approvalComment"),
                    "variantApprovals": variant_approvals,
                }
            )
            deliverables.update(
                {
                    "approvedOutputUrl": next_url,
                    "approvedVariantId": next_variant_id,
                    "approvedVersionId": next_version,
                    "variantApprovals": variant_approvals,
                }
            )
        else:
            # 无剩余批准：回到待审
            metadata["approvalStatus"] = "review_required"
            metadata.pop("approvedVariantId", None)
            metadata.pop("approvedVersionId", None)
            metadata.pop("approvedAt", None)
            metadata["approvalComment"] = (
                payload.comment.strip() if payload.comment else "用户取消批准"
            )
            metadata["variantApprovals"] = {}
            deliverables.pop("approvedOutputUrl", None)
            deliverables.pop("approvedVariantId", None)
            deliverables.pop("approvedVersionId", None)
            deliverables["variantApprovals"] = {}
    else:
        # 取消的是非主批准 variant
        metadata["variantApprovals"] = variant_approvals
        deliverables["variantApprovals"] = variant_approvals

    asset.metadata_json = metadata
    asset.deliverables = deliverables
    session.commit()
    session.refresh(asset)
    return scene_asset_detail(session, asset)


@app.post(
    f"{settings.api_prefix}/assets/{{asset_id}}/renders",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def render_scene_asset_variant(
    asset_id: str,
    payload: SceneAssetRenderRequest,
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
) -> Job:
    asset = get_local_scene_asset(session, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="资产不存在")
    if asset.generation_mode != "structured_3d":
        raise HTTPException(status_code=409, detail="AI 直出资产不支持三维派生渲染")
    source_job = session.get(Job, asset.job_id)
    if source_job is None or source_job.type != "FLOORPLAN_SCENE":
        raise HTTPException(status_code=409, detail="资产缺少可重建的三维场景任务")

    scene_payload = deepcopy(source_job.payload)
    scene_payload["generation_mode"] = "structured_3d"
    scene_payload["render_quality"] = payload.render_quality
    scene_payload["use_blender"] = True
    scene_payload["asset_parent_id"] = asset.id
    scene_payload["asset_module_key"] = scene_asset_read(asset)["module_key"]
    scene_payload["asset_variant_type"] = payload.variant_type
    if payload.variant_type == "camera":
        scene_payload["camera_preset_id"] = payload.camera_preset_id
        camera_names = {
            "corner_01": "右前角",
            "corner_02": "左前角",
            "eye_level_01": "1.6 米平视",
        }
        variant_name = f"机位 · {camera_names[payload.camera_preset_id]}"
    else:
        scene_payload["style_preset_id"] = payload.style_preset_id
        style_names = {
            "modern_warm_v1": "现代暖调",
            "modern_minimal_v1": "现代极简",
            "natural_wood_v1": "自然原木",
        }
        variant_name = f"材质 · {style_names[payload.style_preset_id]}"
    scene_payload["asset_title"] = f"{asset.title} · {variant_name}"[:160]

    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="FLOORPLAN_SCENE",
        payload=scene_payload,
        project_id=asset.project_id,
        parent_job_id=source_job.id,
    )
    dispatch_job(job.id)
    return job


@app.post(
    f"{settings.api_prefix}/floorplans/analyze",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def analyze_floorplan(
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
    source_image: UploadFile = File(...),
    plan_width_mm: int | None = Form(None, ge=2400, le=30000),
    plan_depth_mm: int | None = Form(None, ge=2400, le=30000),
    project_id: str | None = Form(None),
) -> Job:
    source = await save_upload(source_image)
    payload = {
        "source_path": str(source),
        "plan_width_mm": plan_width_mm,
        "plan_depth_mm": plan_depth_mm,
    }
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="FLOORPLAN_ANALYZE",
        payload=payload,
        project_id=project_id,
    )
    dispatch_job(job.id)
    return job


@app.post(
    f"{settings.api_prefix}/floorplan-scenes",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_floorplan_scene(
    payload: FloorplanSceneRequest,
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
) -> Job:
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="FLOORPLAN_SCENE",
        payload=payload.model_dump(),
        project_id=payload.project_id,
    )
    dispatch_job(job.id)
    return job


@app.post(
    f"{settings.api_prefix}/layouts",
    include_in_schema=False,
)
def retired_layout_solver() -> None:
    raise HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="规则求解已下线，请使用 /v1/layouts/ai",
    )


@app.post(
    f"{settings.api_prefix}/layouts/ai",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_ai_layout_job(
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
    source_image: UploadFile = File(...),
    room_type: Literal[
        "whole_home",
        "living_room",
        "dining_room",
        "bedroom",
    ] = Form("whole_home"),
    count: int = Form(1, ge=1, le=2),
    design_prompt: str = Form("", max_length=500),
    semantic_layout: str = Form(..., min_length=2, max_length=500_000),
    stage01_analysis_job_id: str = Form(..., min_length=1, max_length=160),
    stage01_approved_version_id: str = Form(..., min_length=1, max_length=220),
    stage01_source_sha256: str = Form(
        ...,
        min_length=64,
        max_length=64,
        pattern=r"^[0-9a-fA-F]{64}$",
    ),
    stage01_detected_bounds: str = Form(..., min_length=2, max_length=500),
    project_id: str | None = Form(None),
) -> Job:
    semantic_value = _semantic_layout_form(semantic_layout)
    width_mm, depth_mm = _confirmed_stage01_dimensions(semantic_value)
    detected_bounds = _stage01_bounds_form(stage01_detected_bounds)
    analysis_job = session.get(Job, stage01_analysis_job_id)
    if (
        analysis_job is None
        or analysis_job.type != "FLOORPLAN_ANALYZE"
        or analysis_job.status != "SUCCEEDED"
    ):
        raise HTTPException(status_code=422, detail="Stage 01 分析任务不存在或尚未成功")
    if not stage01_approved_version_id.startswith(f"{stage01_analysis_job_id}:"):
        raise HTTPException(status_code=422, detail="Stage 01 批准版本与分析任务不一致")
    analysis_result = analysis_job.result if isinstance(analysis_job.result, dict) else {}
    analysis_semantic = analysis_result.get("semanticLayout")
    analysis_semantic = analysis_semantic if isinstance(analysis_semantic, dict) else {}
    approved_source_sha256 = str(semantic_value.get("sourceSha256") or "").lower()
    analyzed_source_sha256 = str(analysis_semantic.get("sourceSha256") or "").lower()
    submitted_source_sha256 = stage01_source_sha256.lower()
    if not approved_source_sha256 or not analyzed_source_sha256:
        raise HTTPException(status_code=422, detail="Stage 01 缺少可验证的原图摘要")
    if not (submitted_source_sha256 == approved_source_sha256 == analyzed_source_sha256):
        raise HTTPException(status_code=422, detail="Stage 01 原图、语义与分析任务不属于同一版本")
    analysis_bounds = analysis_result.get("detectedBounds")
    if not isinstance(analysis_bounds, dict) or any(
        not isinstance(analysis_bounds.get(key), (int, float))
        or abs(float(analysis_bounds[key]) - detected_bounds[key]) > 0.01
        for key in ("x", "y", "width", "height")
    ):
        raise HTTPException(status_code=422, detail="Stage 01 标注边界与分析任务不一致")
    if project_id and analysis_job.project_id and project_id != analysis_job.project_id:
        raise HTTPException(status_code=422, detail="Stage 01 与 Stage 02 不属于同一项目")
    # W0-b: auto-resolve stage 01 asset as parent
    asset_parent_id = None
    analysis_asset = session.scalar(
        select(SceneAsset).where(SceneAsset.job_id == analysis_job.id)
    )
    if analysis_asset is not None:
        asset_parent_id = analysis_asset.id
    source = await save_upload(source_image)
    payload = {
        "source_path": str(source),
        "room_type": room_type,
        "width_mm": width_mm,
        "depth_mm": depth_mm,
        "count": count,
        "design_prompt": design_prompt.strip(),
        "semantic_layout": semantic_value,
        "stage01_analysis_job_id": stage01_analysis_job_id,
        "stage01_approved_version_id": stage01_approved_version_id,
        "stage01_source_sha256": stage01_source_sha256,
        "stage01_detected_bounds": detected_bounds,
        "asset_parent_id": asset_parent_id,
    }
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="LAYOUT_AI",
        payload=payload,
        project_id=project_id or analysis_job.project_id,
        parent_job_id=analysis_job.id,
    )
    dispatch_job(job.id)
    return job


@app.post(
    f"{settings.api_prefix}/ai-workflow/color-plans",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_ai_color_plan_job(
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
    approved_layout_image: UploadFile = File(...),
    semantic_layout: str = Form(..., min_length=2, max_length=500_000),
    variants: str = Form(",".join(COLOR_PLAN_VARIANTS), max_length=160),
    approved_layout_version_id: str | None = Form(None, max_length=120),
    layout_approved: bool = Form(...),
    design_prompt: str = Form("", max_length=1000),
    style_references: list[UploadFile] | None = File(None),
    asset_parent_id: str = Form(..., min_length=1, max_length=40),
    project_id: str | None = Form(None),
) -> Job:
    """Stage 3: derive one or more AI color-plan styles from an approved layout."""

    project_id = _validate_parent_asset(
        session,
        asset_parent_id,
        project_id=project_id,
        workflow_stage="color_plan",
    )
    if layout_approved is not True:
        raise HTTPException(
            status_code=409,
            detail="只有显式确认已批准的平面布局才能生成彩平图",
        )
    semantic_value = _semantic_layout_form(semantic_layout)
    selected_variants = _csv_values(
        variants,
        defaults=COLOR_PLAN_VARIANTS,
        allowed=COLOR_PLAN_VARIANTS,
        maximum=4,
        label="彩平图类型",
    )
    source = await save_upload(approved_layout_image)
    # 服务端锁定：上传图必须等于上游已批 layout 的批准输出
    lineage = _validate_parent_approved_layout(
        session,
        asset_parent_id,
        approved_layout_version_id=approved_layout_version_id,
        uploaded_layout_path=Path(source),
    )
    resolved_version = (
        lineage.get("parent_approved_version_id")
        or approved_layout_version_id
    )
    reference_paths = await _save_style_references(style_references)
    payload = _validated_workflow_payload(
        AIColorPlanJobPayload,
        {
            "project_id": project_id,
            "approved_layout_path": str(source),
            "approved_layout_version_id": resolved_version,
            "layout_approved": layout_approved,
            "semantic_layout": semantic_value,
            "variant_group_id": new_id("variants"),
            "variants": selected_variants,
            "design_prompt": design_prompt.strip(),
            "style_reference_paths": reference_paths,
            "asset_parent_id": asset_parent_id,
        },
    )
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="AI_COLOR_PLAN",
        payload=payload.model_dump(),
        project_id=project_id,
    )
    dispatch_job(job.id)
    return job


@app.post(
    f"{settings.api_prefix}/ai-workflow/axonometric-views",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_ai_axonometric_job(
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
    approved_layout_image: UploadFile = File(...),
    semantic_layout: str = Form(..., min_length=2, max_length=500_000),
    approved_color_plan_image: UploadFile = File(...),
    variants: str = Form(",".join(AXONOMETRIC_VARIANTS), max_length=160),
    approved_layout_version_id: str | None = Form(None, max_length=120),
    layout_approved: bool = Form(...),
    design_prompt: str = Form("", max_length=1000),
    style_references: list[UploadFile] | None = File(None),
    asset_parent_id: str = Form(..., min_length=1, max_length=40),
    project_id: str | None = Form(None),
) -> Job:
    """Stage 4: generate batched day/night/alternate-angle AI axonometric views."""

    project_id = _validate_parent_asset(
        session,
        asset_parent_id,
        project_id=project_id,
        workflow_stage="axonometric",
    )
    semantic_value = _semantic_layout_form(semantic_layout)
    selected_variants = _csv_values(
        variants,
        defaults=AXONOMETRIC_VARIANTS,
        allowed=AXONOMETRIC_VARIANTS,
        maximum=3,
        label="轴侧图类型",
    )
    if layout_approved is not True:
        raise HTTPException(
            status_code=409,
            detail="只有显式确认已批准的平面布局才能生成轴侧图",
        )
    source = await save_upload(approved_layout_image)
    color_plan = await save_upload(approved_color_plan_image)
    # 布局图 + 彩平图字节均需与已批输出一致（parent 多为彩平资产）
    lineage = _validate_layout_and_color_plan_for_stage45(
        session,
        asset_parent_id,
        approved_layout_version_id=approved_layout_version_id,
        uploaded_layout_path=Path(source),
        uploaded_color_plan_path=Path(color_plan),
    )
    resolved_version = (
        lineage.get("parent_approved_version_id")
        or approved_layout_version_id
    )
    reference_paths = await _save_style_references(style_references)
    payload = _validated_workflow_payload(
        AIAxonometricJobPayload,
        {
            "project_id": project_id,
            "approved_layout_path": str(source),
            "approved_layout_version_id": resolved_version,
            "layout_approved": layout_approved,
            "semantic_layout": semantic_value,
            "variant_group_id": new_id("variants"),
            "variants": selected_variants,
            "approved_color_plan_path": str(color_plan),
            "design_prompt": design_prompt.strip(),
            "style_reference_paths": reference_paths,
            "asset_parent_id": asset_parent_id,
        },
    )
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="AI_AXONOMETRIC",
        payload=payload.model_dump(),
        project_id=project_id,
    )
    dispatch_job(job.id)
    return job


@app.post(
    f"{settings.api_prefix}/ai-workflow/space-renders",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_ai_space_render_job(
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
    approved_layout_image: UploadFile = File(...),
    semantic_layout: str = Form(..., min_length=2, max_length=500_000),
    selected_space_ids: str | None = Form(None, max_length=2000),
    approved_color_plan_image: UploadFile = File(...),
    approved_layout_version_id: str | None = Form(None, max_length=120),
    layout_approved: bool = Form(...),
    view_preset: Literal[
        "eye_level_wide",
        "corner_wide",
        "straight_on",
    ] = Form("eye_level_wide"),
    design_prompt: str = Form("", max_length=1000),
    style_references: list[UploadFile] | None = File(None),
    asset_parent_id: str = Form(..., min_length=1, max_length=40),
    project_id: str | None = Form(None),
) -> Job:
    """Stage 5: generate one consistent interior image for each selected semantic room."""

    project_id = _validate_parent_asset(
        session,
        asset_parent_id,
        project_id=project_id,
        workflow_stage="space_render",
    )
    semantic_value = _semantic_layout_form(semantic_layout)
    selected_spaces = (
        _csv_values(
            selected_space_ids,
            maximum=12,
            label="空间",
        )
        if selected_space_ids and selected_space_ids.strip()
        else []
    )
    if layout_approved is not True:
        raise HTTPException(
            status_code=409,
            detail="只有显式确认已批准的平面布局才能生成分空间效果图",
        )
    source = await save_upload(approved_layout_image)
    color_plan = await save_upload(approved_color_plan_image)
    lineage = _validate_layout_and_color_plan_for_stage45(
        session,
        asset_parent_id,
        approved_layout_version_id=approved_layout_version_id,
        uploaded_layout_path=Path(source),
        uploaded_color_plan_path=Path(color_plan),
    )
    resolved_version = (
        lineage.get("parent_approved_version_id")
        or approved_layout_version_id
    )
    reference_paths = await _save_style_references(style_references)
    payload = _validated_workflow_payload(
        AISpaceRenderJobPayload,
        {
            "project_id": project_id,
            "approved_layout_path": str(source),
            "approved_layout_version_id": resolved_version,
            "layout_approved": layout_approved,
            "semantic_layout": semantic_value,
            "variant_group_id": new_id("variants"),
            "selected_space_ids": selected_spaces,
            "approved_color_plan_path": str(color_plan),
            "view_preset": view_preset,
            "design_prompt": design_prompt.strip(),
            "style_reference_paths": reference_paths,
            "asset_parent_id": asset_parent_id,
        },
    )
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="AI_SPACE_RENDER",
        payload=payload.model_dump(),
        project_id=project_id,
    )
    dispatch_job(job.id)
    return job


@app.post(
    f"{settings.api_prefix}/ai-workflow/style-schemes",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_ai_style_scheme_job(
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
    source_space_image: UploadFile = File(...),
    semantic_layout: str = Form(..., min_length=2, max_length=500_000),
    space_id: str = Form(..., min_length=1, max_length=120),
    variants: str = Form(
        ",".join(STYLE_SCHEME_VARIANTS[:3]),
        max_length=160,
    ),
    source_approved: bool = Form(...),
    source_space_version_id: str = Form(..., min_length=1, max_length=220),
    design_prompt: str = Form("", max_length=1000),
    style_references: list[UploadFile] | None = File(None),
    asset_parent_id: str = Form(..., min_length=1, max_length=40),
    project_id: str | None = Form(None),
) -> Job:
    """Stage 6: generate same-camera style alternatives for one approved space."""

    project_id = _validate_parent_asset(
        session,
        asset_parent_id,
        project_id=project_id,
        workflow_stage="style_scheme",
    )
    semantic_value = _semantic_layout_form(semantic_layout)
    selected_variants = _csv_values(
        variants,
        defaults=STYLE_SCHEME_VARIANTS[:3],
        allowed=STYLE_SCHEME_VARIANTS,
        maximum=4,
        label="风格方案",
    )
    source = await save_upload(source_space_image)
    lineage = _validate_parent_approved_space(
        session,
        asset_parent_id,
        space_id=space_id,
        source_space_version_id=source_space_version_id,
        source_space_path=source,
    )
    reference_paths = await _save_style_references(style_references)
    payload = _validated_workflow_payload(
        AIStyleSchemeJobPayload,
        {
            "project_id": project_id,
            "source_space_path": str(source),
            "source_space_version_id": source_space_version_id,
            "source_approved": source_approved,
            "semantic_layout": semantic_value,
            "space_id": space_id,
            "variant_group_id": new_id("variants"),
            "variants": selected_variants,
            "design_prompt": design_prompt.strip(),
            "style_reference_paths": reference_paths,
            "asset_parent_id": asset_parent_id,
            **lineage,
        },
    )
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="AI_STYLE_SCHEME",
        payload=payload.model_dump(),
        project_id=project_id,
    )
    dispatch_job(job.id)
    return job


@app.post(
    f"{settings.api_prefix}/ai-workflow/tone-schemes",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_ai_tone_scheme_job(
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
    source_space_image: UploadFile = File(...),
    semantic_layout: str = Form(..., min_length=2, max_length=500_000),
    space_id: str = Form(..., min_length=1, max_length=120),
    variants: str = Form(",".join(TONE_SCHEME_VARIANTS), max_length=160),
    source_approved: bool = Form(...),
    source_space_version_id: str = Form(..., min_length=1, max_length=220),
    design_prompt: str = Form("", max_length=1000),
    asset_parent_id: str = Form(..., min_length=1, max_length=40),
    project_id: str | None = Form(None),
) -> Job:
    """Stage 7: generate color-temperature and lighting moods for one approved style."""

    project_id = _validate_parent_asset(
        session,
        asset_parent_id,
        project_id=project_id,
        workflow_stage="tone_scheme",
    )
    semantic_value = _semantic_layout_form(semantic_layout)
    selected_variants = _csv_values(
        variants,
        defaults=TONE_SCHEME_VARIANTS,
        allowed=TONE_SCHEME_VARIANTS,
        maximum=3,
        label="色调方案",
    )
    source = await save_upload(source_space_image)
    lineage = _validate_parent_approved_space(
        session,
        asset_parent_id,
        space_id=space_id,
        source_space_version_id=source_space_version_id,
        source_space_path=source,
    )
    payload = _validated_workflow_payload(
        AIToneSchemeJobPayload,
        {
            "project_id": project_id,
            "source_space_path": str(source),
            "source_space_version_id": source_space_version_id,
            "source_approved": source_approved,
            "semantic_layout": semantic_value,
            "space_id": space_id,
            "variant_group_id": new_id("variants"),
            "variants": selected_variants,
            "design_prompt": design_prompt.strip(),
            "asset_parent_id": asset_parent_id,
            **lineage,
        },
    )
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="AI_TONE_SCHEME",
        payload=payload.model_dump(),
        project_id=project_id,
    )
    dispatch_job(job.id)
    return job


@app.post(
    f"{settings.api_prefix}/ai-workflow/local-edits",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_ai_local_edit_job(
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
    source_space_image: UploadFile = File(...),
    mark_image: UploadFile = File(...),
    semantic_layout: str = Form(..., min_length=2, max_length=500_000),
    space_id: str = Form(..., min_length=1, max_length=120),
    edit_prompt: str = Form(..., min_length=1, max_length=1000),
    source_approved: bool = Form(...),
    source_space_version_id: str = Form(..., min_length=1, max_length=220),
    asset_parent_id: str = Form(..., min_length=1, max_length=40),
    project_id: str | None = Form(None),
) -> Job:
    """Stage 8: edit only the red-marked regions and restore every other pixel."""

    project_id = _validate_parent_asset(
        session,
        asset_parent_id,
        project_id=project_id,
        workflow_stage="local_edit",
    )
    semantic_value = _semantic_layout_form(semantic_layout)
    source = await save_upload(source_space_image)
    lineage = _validate_parent_approved_space(
        session,
        asset_parent_id,
        space_id=space_id,
        source_space_version_id=source_space_version_id,
        source_space_path=source,
    )
    mark = await save_upload(mark_image)
    payload = _validated_workflow_payload(
        AILocalEditJobPayload,
        {
            "project_id": project_id,
            "source_space_path": str(source),
            "source_space_version_id": source_space_version_id,
            "source_approved": source_approved,
            "semantic_layout": semantic_value,
            "space_id": space_id,
            "variant_group_id": new_id("variants"),
            "mark_path": str(mark),
            "edit_prompt": edit_prompt.strip(),
            "asset_parent_id": asset_parent_id,
            **lineage,
        },
    )
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="AI_LOCAL_EDIT",
        payload=payload.model_dump(),
        project_id=project_id,
    )
    dispatch_job(job.id)
    return job


@app.post(
    f"{settings.api_prefix}/white-model-renders",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_white_model_job(
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
    source_image: UploadFile = File(...),
    room_type: str = Form("living_room"),
    style_preset_id: str = Form("modern_minimal_v1"),
    prompt: str = Form("", max_length=500),
    generation_mode: Literal["ai_quick", "local_preview"] = Form("ai_quick"),
    style_references: list[UploadFile] | None = File(None),
    project_id: str | None = Form(None),
) -> Job:
    references = style_references or []
    if len(references) > 3:
        raise HTTPException(status_code=422, detail="风格参考图最多上传 3 张")
    source = await save_upload(source_image)
    reference_paths = [await save_upload(reference) for reference in references]
    payload = {
        "source_path": str(source),
        "room_type": room_type,
        "style_preset_id": style_preset_id,
        "prompt": prompt.strip(),
        "generation_mode": generation_mode,
        "style_reference_paths": [str(path) for path in reference_paths],
    }
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="WHITE_MODEL_RENDER",
        payload=payload,
        project_id=project_id,
    )
    dispatch_job(job.id)
    return job


@app.get(
    f"{settings.api_prefix}/scenes/camera-presets",
    response_model=list[CameraPreset],
)
def camera_presets() -> list[CameraPreset]:
    return [
        CameraPreset(
            id="corner_01",
            name="右前角",
            description="从房间右前角朝中心观察",
        ),
        CameraPreset(
            id="corner_02",
            name="左前角",
            description="从房间左前角朝中心观察",
        ),
        CameraPreset(
            id="eye_level_01",
            name="平视",
            description="1.6 米平视安全机位",
        ),
    ]


@app.post(
    f"{settings.api_prefix}/effect-renders",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def create_effect_render_job(
    payload: EffectRenderRequest,
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
) -> Job:
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="EFFECT_RENDER",
        payload=payload.model_dump(),
        project_id=payload.project_id,
    )
    dispatch_job(job.id)
    return job


@app.post(
    f"{settings.api_prefix}/material-replacement-renders",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_material_job(
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
    source_image: UploadFile = File(...),
    wall_mask: UploadFile | None = File(None),
    floor_mask: UploadFile | None = File(None),
    wall_style: Literal[
        "warm_gray",
        "ivory",
        "sage",
        "clay",
        "microcement_cream",
        "travertine_beige",
    ] = Form("warm_gray"),
    floor_style: Literal[
        "oak_light",
        "oak_natural",
        "walnut",
        "stone_gray",
        "terrazzo_light",
    ] = Form("oak_light"),
    project_id: str | None = Form(None),
) -> Job:
    source = await save_upload(source_image)
    wall_path = await save_upload(wall_mask) if wall_mask else None
    floor_path = await save_upload(floor_mask) if floor_mask else None
    payload = {
        "source_path": str(source),
        "wall_mask_path": str(wall_path) if wall_path else None,
        "floor_mask_path": str(floor_path) if floor_path else None,
        "wall_style": wall_style,
        "floor_style": floor_style,
    }
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type="MATERIAL_REPLACEMENT",
        payload=payload,
        project_id=project_id,
    )
    dispatch_job(job.id)
    return job


@app.get(f"{settings.api_prefix}/jobs/{{job_id}}", response_model=JobRead)
def get_job(job_id: str, session: SessionDep) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    # C3+C4 竞态愈合：SUCCEEDED 与资产归档是两个事务，轮询可能先看到
    # SUCCEEDED 而 result.assetId 尚未写入——读到时惰性补归档，对所有调用方收敛
    if (
        job.status == "SUCCEEDED"
        and job.type in ASSET_JOB_TYPES
        and not (job.result or {}).get("assetId")
    ):
        archive_job_asset(job.id)
        session.expire(job)
        session.refresh(job)
    return job


@app.post(
    f"{settings.api_prefix}/jobs/{{job_id}}/retry",
    response_model=JobRead,
    status_code=status.HTTP_202_ACCEPTED,
)
def retry_job(
    job_id: str,
    session: SessionDep,
    idempotency_key: IdempotencyKeyHeader = None,
) -> Job:
    original = session.get(Job, job_id)
    if original is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if original.type == "LAYOUT":
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="规则求解已下线，历史任务不可重试；请使用 /v1/layouts/ai",
        )
    job = create_job(
        session,
        idempotency_key=idempotency_key,
        job_type=original.type,
        payload=original.payload,
        project_id=original.project_id,
        parent_job_id=original.id,
    )
    dispatch_job(job.id)
    return job


@app.post(f"{settings.api_prefix}/jobs/{{job_id}}/cancel", response_model=JobRead)
def cancel_job(job_id: str, session: SessionDep) -> Job:
    # C3：条件更新消除「检查-写入」竞态——只有未终态的行才会被置为 CANCELED
    updated = session.execute(
        update(Job)
        .where(Job.id == job_id, Job.status.notin_(["SUCCEEDED", "FAILED"]))
        .values(status="CANCELED")
    ).rowcount
    session.commit()
    session.expire_all()
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if updated == 0:
        raise HTTPException(status_code=409, detail="任务已经结束，不能取消")
    return job


@app.get(f"{settings.api_prefix}/jobs", response_model=list[JobRead])
def list_jobs(
    session: SessionDep,
    project_id: Annotated[
        str | None,
        Query(alias="projectId", min_length=1, max_length=40),
    ] = None,
    status: Annotated[str | None, Query(min_length=1, max_length=20)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[Job]:
    statement = select(Job).order_by(Job.created_at.desc())
    if project_id:
        statement = statement.where(Job.project_id == project_id)
    if status:
        statement = statement.where(Job.status == status)
    statement = statement.offset(offset).limit(limit)
    return list(session.scalars(statement))


# W0-d: Canvas persistence endpoints


@app.get(f"{settings.api_prefix}/projects/{{project_id}}/canvas-graph")
def get_project_canvas_graph(
    project_id: str,
    session: SessionDep,
    include_orphans: Annotated[
        bool,
        Query(alias="includeOrphans"),
    ] = False,
) -> dict[str, Any]:
    """W0-e：项目画布图谱——逐图节点 + parent→child 派生连线（逻辑结构，不含坐标）。

    includeOrphans：合并 project_id IS NULL 的存量资产（W2-2 默认项目策略回退）。
    """
    return build_project_canvas_graph(
        session, project_id, include_orphans=include_orphans
    )


@app.post(
    f"{settings.api_prefix}/canvases",
    response_model=CanvasRead,
    status_code=status.HTTP_201_CREATED,
)
def create_canvas(payload: CanvasCreate, session: SessionDep) -> Canvas:
    canvas = Canvas(
        project_id=payload.project_id,
        name=payload.name,
        viewport_json=payload.viewport_json or {},
    )
    session.add(canvas)
    session.commit()
    session.refresh(canvas)
    return canvas


@app.get(f"{settings.api_prefix}/canvases", response_model=list[CanvasRead])
def list_canvases(
    session: SessionDep,
    project_id: Annotated[
        str,
        Query(alias="projectId", min_length=1, max_length=40),
    ],
) -> list[Canvas]:
    statement = (
        select(Canvas)
        .where(Canvas.project_id == project_id, Canvas.deleted_at.is_(None))
        .order_by(Canvas.updated_at.desc())
    )
    return list(session.scalars(statement))


@app.get(f"{settings.api_prefix}/canvases/{{canvas_id}}", response_model=CanvasDetail)
def get_canvas(canvas_id: str, session: SessionDep) -> dict[str, Any]:
    canvas = session.get(Canvas, canvas_id)
    if canvas is None or canvas.deleted_at is not None:
        raise HTTPException(status_code=404, detail="画布不存在")
    nodes = list(
        session.scalars(
            select(CanvasNode)
            .where(CanvasNode.canvas_id == canvas_id, CanvasNode.deleted_at.is_(None))
            .order_by(CanvasNode.z, CanvasNode.created_at)
        )
    )
    return {
        "id": canvas.id,
        "project_id": canvas.project_id,
        "name": canvas.name,
        "viewport_json": canvas.viewport_json,
        "updated_at": canvas.updated_at,
        "nodes": [
            {
                "id": node.id,
                "canvas_id": node.canvas_id,
                "asset_id": node.asset_id,
                "variant_id": node.variant_id,
                "job_id": node.job_id,
                "x": node.x,
                "y": node.y,
                "w": node.w,
                "h": node.h,
                "z": node.z,
                "source_node_id": node.source_node_id,
                "created_at": node.created_at,
                "updated_at": node.updated_at,
            }
            for node in nodes
        ],
    }


@app.patch(f"{settings.api_prefix}/canvases/{{canvas_id}}", response_model=CanvasRead)
def update_canvas(
    canvas_id: str,
    payload: CanvasCreate,
    session: SessionDep,
) -> Canvas:
    canvas = session.get(Canvas, canvas_id)
    if canvas is None or canvas.deleted_at is not None:
        raise HTTPException(status_code=404, detail="画布不存在")
    canvas.name = payload.name
    if payload.viewport_json is not None:
        canvas.viewport_json = payload.viewport_json
    session.commit()
    session.refresh(canvas)
    return canvas


@app.delete(f"{settings.api_prefix}/canvases/{{canvas_id}}")
def delete_canvas(canvas_id: str, session: SessionDep) -> dict[str, str]:
    canvas = session.get(Canvas, canvas_id)
    if canvas is None or canvas.deleted_at is not None:
        raise HTTPException(status_code=404, detail="画布不存在")
    canvas.deleted_at = utc_now()
    session.commit()
    return {"status": "deleted"}


@app.post(
    f"{settings.api_prefix}/canvases/{{canvas_id}}/nodes",
    response_model=CanvasNodeRead,
    status_code=status.HTTP_201_CREATED,
)
def create_canvas_node(
    canvas_id: str,
    payload: CanvasNodeCreate,
    session: SessionDep,
) -> CanvasNode:
    canvas = session.get(Canvas, canvas_id)
    if canvas is None or canvas.deleted_at is not None:
        raise HTTPException(status_code=404, detail="画布不存在")
    node = CanvasNode(
        canvas_id=canvas_id,
        asset_id=payload.asset_id,
        variant_id=payload.variant_id,
        job_id=payload.job_id,
        x=payload.x,
        y=payload.y,
        w=payload.w,
        h=payload.h,
        z=payload.z,
        source_node_id=payload.source_node_id,
    )
    session.add(node)
    session.commit()
    session.refresh(node)
    return node


@app.patch(
    f"{settings.api_prefix}/canvases/{{canvas_id}}/nodes/batch",
    response_model=list[CanvasNodeRead],
)
def batch_patch_canvas_nodes(
    canvas_id: str,
    payload: CanvasNodeBatchPatch,
    session: SessionDep,
) -> list[CanvasNode]:
    canvas = session.get(Canvas, canvas_id)
    if canvas is None or canvas.deleted_at is not None:
        raise HTTPException(status_code=404, detail="画布不存在")
    result: list[CanvasNode] = []
    for item in payload.nodes:
        node_id = item.get("id")
        if not isinstance(node_id, str) or not node_id:
            continue
        node = session.get(CanvasNode, node_id)
        if node is None or node.deleted_at is not None or node.canvas_id != canvas_id:
            continue
        if "x" in item and item["x"] is not None:
            node.x = float(item["x"])
        if "y" in item and item["y"] is not None:
            node.y = float(item["y"])
        if "w" in item and item["w"] is not None:
            node.w = float(item["w"])
        if "h" in item and item["h"] is not None:
            node.h = float(item["h"])
        if "z" in item and item["z"] is not None:
            node.z = int(item["z"])
        result.append(node)
    session.commit()
    for node in result:
        session.refresh(node)
    return result


@app.delete(
    f"{settings.api_prefix}/canvases/{{canvas_id}}/nodes/{{node_id}}",
)
def delete_canvas_node(
    canvas_id: str,
    node_id: str,
    session: SessionDep,
) -> dict[str, str]:
    canvas = session.get(Canvas, canvas_id)
    if canvas is None or canvas.deleted_at is not None:
        raise HTTPException(status_code=404, detail="画布不存在")
    node = session.get(CanvasNode, node_id)
    if node is None or node.deleted_at is not None or node.canvas_id != canvas_id:
        raise HTTPException(status_code=404, detail="节点不存在")
    node.deleted_at = utc_now()
    session.commit()
    return {"status": "deleted"}
