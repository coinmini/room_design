/**
 * 画布内 01→08 执行编排：从节点上下文拼 FormData → 调 API → pollJob。
 */

import {
  apiFetch,
  cancelJob,
  createAiLayout,
  createAxonometricRenders,
  createColorPlanRenders,
  createFloorplanAnalyze,
  createLocalEditRender,
  createSpaceRenders,
  createStyleSchemeRenders,
  createToneSchemeRenders,
  pollJob,
  retryJob,
  type Job,
} from '../api'
import type { CanvasGraphNode } from '../canvas/types'
import { normalizeStage } from '../canvas/types'
import { approveVariantIdempotent, unapproveVariant } from './actions'
import {
  AXONOMETRIC_VARIANT_LABELS,
  AXONOMETRIC_VARIANTS,
  COLOR_PLAN_VARIANTS,
  STYLE_SCHEME_VARIANT_LABELS,
  STYLE_SCHEME_VARIANTS,
  TONE_SCHEME_VARIANT_LABELS,
  TONE_SCHEME_VARIANTS,
} from './constants'
import { apiError, fetchArtifactAsFile, recordValue } from './media'

export type RunnerNotice = (message: string) => void
export type JobListener = (job: Job) => void

export type StagePanelRequest =
  | { kind: 'upload_floorplan' }
  | { kind: 'space_select'; rooms: Array<{ id: string; name: string }> }
  | {
      kind: 'style_select'
      options: Array<{ id: string; name: string }>
    }
  | {
      kind: 'tone_select'
      options: Array<{ id: string; name: string }>
    }
  | {
      kind: 'axonometric_select'
      options: Array<{ id: string; name: string }>
    }
  | {
      kind: 'local_edit'
      sourceUrl: string
      spaceId: string
      assetId: string
      versionId: string
    }

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

async function fetchJson(path: string): Promise<Record<string, unknown>> {
  const response = await apiFetch(path, { cache: 'no-store' })
  if (!response.ok) throw new Error(`请求失败：${response.status}`)
  return recordValue(await response.json())
}

async function fetchAsset(assetId: string) {
  return fetchJson(`/v1/assets/${encodeURIComponent(assetId)}`)
}

async function fetchResume(assetId: string) {
  return fetchJson(
    `/v1/assets/${encodeURIComponent(assetId)}/workflow-resume`,
  )
}

function semanticFromValue(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value
  if (value && typeof value === 'object') return JSON.stringify(value)
  return ''
}

/** 从资产详情 / resume / job 尽力解析 semantic JSON 字符串。 */
async function resolveSemanticLayout(assetId: string): Promise<string> {
  try {
    const resume = await fetchResume(assetId)
    const fromResume = semanticFromValue(resume.semanticLayout ?? resume.semantic_layout)
    if (fromResume) return fromResume
  } catch {
    // 未批准资产可能 409
  }
  const asset = await fetchAsset(assetId)
  const metadata = recordValue(asset.metadata)
  const sourcePayload = recordValue(asset.sourcePayload)
  const sourceResult = recordValue(asset.sourceResult)
  const candidates = [
    sourcePayload.semantic_layout,
    sourcePayload.semanticLayout,
    sourceResult.semanticLayout,
    sourceResult.semantic_layout,
    metadata.semanticLayout,
  ]
  for (const item of candidates) {
    const text = semanticFromValue(item)
    if (text) return text
  }
  // 向上游回溯
  const parentId = pickString(asset.parentAssetId, metadata.parentAssetId)
  if (parentId) return resolveSemanticLayout(parentId)
  throw new Error('无法解析 SemanticLayout，请先完成并确认户型/布局阶段')
}

function roomsFromSemantic(semanticJson: string): Array<{ id: string; name: string }> {
  try {
    const parsed = JSON.parse(semanticJson) as Record<string, unknown>
    const rooms = Array.isArray(parsed.rooms) ? parsed.rooms : []
    return rooms
      .map((room, index) => {
        const record = recordValue(room)
        const id = pickString(record.id) || `room_${index + 1}`
        const name = pickString(record.name, record.type) || id
        return { id, name }
      })
      .filter((room) => room.id)
  } catch {
    return []
  }
}

async function postAndPoll(
  request: Promise<Response>,
  onJob?: JobListener,
  signal?: AbortSignal,
): Promise<Job> {
  const response = await request
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: unknown
    } | null
    throw new Error(apiError(payload?.detail, response.status))
  }
  const created = (await response.json()) as Job
  onJob?.(created)
  const completed = await pollJob(created.id, onJob, undefined, signal)
  onJob?.(completed)
  if (completed.status === 'FAILED') {
    throw new Error(completed.errorMessage || '生成失败')
  }
  return completed
}

export async function runFloorplanAnalyze(params: {
  projectId: string
  file: File
  planWidthMm?: number
  planDepthMm?: number
  onJob?: JobListener
  signal?: AbortSignal
}): Promise<Job> {
  const form = new FormData()
  form.append('source_image', params.file)
  form.append('project_id', params.projectId)
  if (params.planWidthMm) form.append('plan_width_mm', String(params.planWidthMm))
  if (params.planDepthMm) form.append('plan_depth_mm', String(params.planDepthMm))
  return postAndPoll(createFloorplanAnalyze(form), params.onJob, params.signal)
}

async function runLayoutFromFloorplan(
  projectId: string,
  node: CanvasGraphNode,
  designPrompt: string,
  stage01Approval: Stage01ApprovalPayload | undefined,
  onJob?: JobListener,
  signal?: AbortSignal,
): Promise<Job> {
  if (!node.assetId || !node.jobId) {
    throw new Error('户型节点缺少 assetId/jobId')
  }
  if (!stage01Approval) {
    throw new Error('请先打开结构编辑器并确认结构后再生成布局')
  }
  if (stage01Approval.analysisJobId !== node.jobId) {
    throw new Error('结构确认与当前节点不匹配，请重新打开编辑器确认')
  }

  const semanticValue =
    typeof stage01Approval.semanticLayout === 'string'
      ? stage01Approval.semanticLayout
      : JSON.stringify(stage01Approval.semanticLayout)
  let sourceSha256 = pickString(stage01Approval.sourceSha256)
  if (!sourceSha256 || sourceSha256.length !== 64) {
    // 从确认语义中再取
    try {
      const parsed = JSON.parse(semanticValue) as Record<string, unknown>
      sourceSha256 = pickString(parsed.sourceSha256)
    } catch {
      /* ignore */
    }
  }
  if (!sourceSha256 || sourceSha256.length !== 64) {
    throw new Error('结构确认缺少 sourceSha256，请在编辑器中重新确认')
  }
  const bounds = stage01Approval.detectedBounds
  if (!bounds?.width) {
    throw new Error('结构确认缺少 detectedBounds')
  }

  const form = new FormData()
  form.append('source_image', stage01Approval.approvedLayoutImage)
  form.append('room_type', 'whole_home')
  form.append('count', '2')
  form.append('design_prompt', designPrompt)
  form.append('semantic_layout', semanticValue)
  form.append('stage01_analysis_job_id', stage01Approval.analysisJobId)
  form.append(
    'stage01_approved_version_id',
    stage01Approval.approvedLayoutVersionId,
  )
  form.append('stage01_source_sha256', sourceSha256.toLowerCase())
  form.append(
    'stage01_detected_bounds',
    JSON.stringify({
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Number(bounds.width),
      height: Number(bounds.height),
    }),
  )
  form.append('project_id', projectId)
  return postAndPoll(createAiLayout(form), onJob, signal)
}

async function resolveLayoutLineage(assetId: string): Promise<{
  layoutImage: File
  layoutVersionId: string
  colorPlanImage?: File
  colorPlanAssetId?: string
  semantic: string
  layoutAssetId: string
}> {
  // 从当前资产向上游找到 layout + color_plan
  let cursor: string | null = assetId
  let layoutAssetId = ''
  let layoutVersionId = ''
  let layoutUrl = ''
  let colorUrl = ''
  let colorPlanAssetId = ''
  let semantic = ''

  for (let i = 0; i < 12 && cursor; i += 1) {
    const asset = await fetchAsset(cursor)
    const metadata = recordValue(asset.metadata)
    const deliverables = recordValue(asset.deliverables)
    const stage = pickString(metadata.workflowStage, metadata.moduleKey)
    const moduleKey = pickString(metadata.moduleKey)

    if (!semantic) {
      try {
        semantic = await resolveSemanticLayout(cursor)
      } catch {
        /* continue */
      }
    }

    if (
      !layoutAssetId &&
      (moduleKey === 'layout' || stage === 'layout')
    ) {
      layoutAssetId = String(asset.id)
      layoutVersionId = pickString(
        metadata.approvedVersionId,
        deliverables.approvedVersionId,
      )
      layoutUrl = pickString(
        deliverables.approvedOutputUrl,
        deliverables.previewUrl,
        ...(Array.isArray(deliverables.previewUrls)
          ? (deliverables.previewUrls as unknown[])
          : []),
        asset.thumbnailUrl as string,
      )
      // layoutVariants
      const variants = deliverables.layoutVariants
      if (!layoutUrl && Array.isArray(variants) && variants[0]) {
        layoutUrl = pickString(recordValue(variants[0]).previewUrl)
      }
    }

    if (
      !colorPlanAssetId &&
      (stage === 'color_plan' ||
        pickString(asset.assetType) === 'ai_color_plan')
    ) {
      colorPlanAssetId = String(asset.id)
      colorUrl = pickString(
        deliverables.approvedOutputUrl,
        ...(Array.isArray(deliverables.outputs)
          ? (deliverables.outputs as unknown[]).map((o) =>
              pickString(recordValue(o).url),
            )
          : []),
        asset.thumbnailUrl as string,
      )
    }

    cursor = pickString(asset.parentAssetId, metadata.parentAssetId) || null
  }

  // 若当前就是 layout
  if (!layoutAssetId) {
    const asset = await fetchAsset(assetId)
    const metadata = recordValue(asset.metadata)
    if (pickString(metadata.moduleKey) === 'layout') {
      layoutAssetId = assetId
      layoutVersionId = pickString(metadata.approvedVersionId)
      const deliverables = recordValue(asset.deliverables)
      layoutUrl = pickString(
        deliverables.approvedOutputUrl,
        asset.thumbnailUrl as string,
      )
    }
  }

  if (!layoutAssetId || !layoutUrl) {
    throw new Error('找不到已批准的平面布局图，请先批准布局节点')
  }
  if (!layoutVersionId) {
    // 尝试批准状态；未批准则提示
    throw new Error('布局尚未批准，请先在布局节点上点击「批准」')
  }
  if (!semantic) semantic = await resolveSemanticLayout(layoutAssetId)

  const layoutImage = await fetchArtifactAsFile(layoutUrl, 'approved-layout')
  const colorPlanImage = colorUrl
    ? await fetchArtifactAsFile(colorUrl, 'approved-color-plan')
    : undefined

  return {
    layoutImage,
    layoutVersionId,
    colorPlanImage,
    colorPlanAssetId: colorPlanAssetId || undefined,
    semantic,
    layoutAssetId,
  }
}

async function runColorPlan(
  projectId: string,
  node: CanvasGraphNode,
  designPrompt: string,
  onJob?: JobListener,
  signal?: AbortSignal,
): Promise<Job> {
  if (!node.assetId) throw new Error('缺少上游资产')
  // 需要本 variant 已批准（支持多 variant 分叉批准）
  const asset = await fetchAsset(node.assetId)
  const metadata = recordValue(asset.metadata)
  const deliverables = recordValue(asset.deliverables)
  const variantApprovals = recordValue(metadata.variantApprovals)
  const thisApproval = node.variantId
    ? recordValue(variantApprovals[node.variantId])
    : {}
  const thisApproved =
    Boolean(node.approved) ||
    (typeof thisApproval.versionId === 'string' && Boolean(thisApproval.versionId)) ||
    (metadata.approvalStatus === 'approved' &&
      pickString(metadata.approvedVariantId) === node.variantId)
  if (!thisApproved && metadata.approvalStatus !== 'approved') {
    throw new Error('请先批准当前布局节点')
  }
  if (!thisApproved && node.variantId) {
    // 资产已批但不是本 variant：先批本节点
    const approved = await approveVariantIdempotent({
      assetId: node.assetId,
      variantId: node.variantId,
      comment: '生成彩平前自动批准布局方案',
    })
    // 用批准结果继续
    const url = pickString(node.url, asset.thumbnailUrl as string)
    if (!url) throw new Error('布局节点缺少预览图')
    const layoutImage = await fetchArtifactAsFile(url, 'approved-layout')
    const semantic = await resolveSemanticLayout(node.assetId)
    const form = new FormData()
    form.append('approved_layout_image', layoutImage)
    form.append('layout_approved', 'true')
    form.append('semantic_layout', semantic)
    form.append('variants', COLOR_PLAN_VARIANTS.join(','))
    form.append('asset_parent_id', node.assetId)
    form.append('project_id', projectId)
    form.append('approved_layout_version_id', approved.approvedVersionId)
    if (designPrompt) form.append('design_prompt', designPrompt)
    return postAndPoll(createColorPlanRenders(form), onJob, signal)
  }
  const url = pickString(
    node.url,
    pickString(thisApproval.outputUrl),
    deliverables.approvedOutputUrl,
    asset.thumbnailUrl as string,
  )
  if (!url) throw new Error('布局节点缺少预览图')
  const layoutImage = await fetchArtifactAsFile(url, 'approved-layout')
  const versionId = pickString(
    node.approvedVersionId,
    pickString(thisApproval.versionId),
    metadata.approvedVersionId,
    deliverables.approvedVersionId,
  )
  const semantic = await resolveSemanticLayout(node.assetId)
  const form = new FormData()
  form.append('approved_layout_image', layoutImage)
  form.append('layout_approved', 'true')
  form.append('semantic_layout', semantic)
  form.append('variants', COLOR_PLAN_VARIANTS.join(','))
  form.append('asset_parent_id', node.assetId)
  form.append('project_id', projectId)
  if (versionId) form.append('approved_layout_version_id', versionId)
  if (designPrompt) form.append('design_prompt', designPrompt)
  return postAndPoll(createColorPlanRenders(form), onJob, signal)
}

async function runAxonometricOrSpace(
  projectId: string,
  node: CanvasGraphNode,
  kind: 'axonometric' | 'space_render',
  designPrompt: string,
  selectedSpaceIds: string[] | undefined,
  onJob?: JobListener,
  signal?: AbortSignal,
  selectedAxonometricVariants?: string[],
): Promise<Job> {
  if (!node.assetId) throw new Error('缺少上游资产')
  const asset = await fetchAsset(node.assetId)
  const metadata = recordValue(asset.metadata)
  if (metadata.approvalStatus !== 'approved' && !node.approved) {
    throw new Error('请先批准当前节点（彩平/轴侧）')
  }
  // 当前节点应是 color_plan 或 axonometric
  const stage = normalizeStage(node)
  const parentForLineage =
    stage === 'color_plan' || stage === 'axonometric'
      ? node.assetId
      : pickString(asset.parentAssetId) || node.assetId

  const lineage = await resolveLayoutLineage(parentForLineage)
  // 彩平图：优先当前节点输出
  let colorFile = lineage.colorPlanImage
  if (stage === 'color_plan' || !colorFile) {
    const deliverables = recordValue(asset.deliverables)
    const colorUrl = pickString(
      deliverables.approvedOutputUrl,
      node.url,
      ...(Array.isArray(deliverables.outputs)
        ? (deliverables.outputs as unknown[]).map((o) =>
            pickString(recordValue(o).url),
          )
        : []),
    )
    if (!colorUrl) throw new Error('缺少彩平图')
    colorFile = await fetchArtifactAsFile(colorUrl, 'color-plan')
  }

  const form = new FormData()
  form.append('approved_layout_image', lineage.layoutImage)
  form.append('approved_color_plan_image', colorFile)
  form.append('layout_approved', 'true')
  form.append('semantic_layout', lineage.semantic)
  form.append('asset_parent_id', node.assetId)
  form.append('project_id', projectId)
  form.append('approved_layout_version_id', lineage.layoutVersionId)
  if (designPrompt) form.append('design_prompt', designPrompt)

  if (kind === 'axonometric') {
    const allowed = new Set<string>(AXONOMETRIC_VARIANTS)
    const picked = (selectedAxonometricVariants || []).filter((id) =>
      allowed.has(id),
    )
    form.append(
      'variants',
      (picked.length ? picked : [...AXONOMETRIC_VARIANTS]).join(','),
    )
    return postAndPoll(createAxonometricRenders(form), onJob, signal)
  }
  form.append(
    'selected_space_ids',
    (selectedSpaceIds && selectedSpaceIds.length
      ? selectedSpaceIds
      : roomsFromSemantic(lineage.semantic).map((r) => r.id)
    ).join(','),
  )
  form.append('view_preset', 'eye_level_wide')
  return postAndPoll(createSpaceRenders(form), onJob, signal)
}

async function runDerivative(
  projectId: string,
  node: CanvasGraphNode,
  kind: 'style' | 'tone' | 'local_edit',
  designPrompt: string,
  extras?: {
    markFile?: File
    editPrompt?: string
    /** 风格/色调：用户勾选的 variant id 列表 */
    selectedVariants?: string[]
  },
  onJob?: JobListener,
  signal?: AbortSignal,
): Promise<Job> {
  if (!node.assetId || !node.variantId) {
    throw new Error('缺少上游资产或 variant')
  }
  const asset = await fetchAsset(node.assetId)
  const metadata = recordValue(asset.metadata)
  // 确保已批准（当前 variant 或任意批准）
  let versionId = pickString(
    node.approvedVersionId,
    metadata.approvedVersionId,
  )
  const approvedVariant = pickString(metadata.approvedVariantId)
  if (metadata.approvalStatus !== 'approved' || approvedVariant !== node.variantId) {
    const approved = await approveVariantIdempotent({
      assetId: node.assetId,
      variantId: node.variantId,
      comment: '画布派生前自动批准上游节点',
    })
    versionId = approved.approvedVersionId
  }
  if (!versionId) throw new Error('上游缺少 approvedVersionId')

  const spaceId = pickString(
    metadata.spaceId,
    recordValue(
      Array.isArray(recordValue(asset.deliverables).outputs)
        ? (recordValue(asset.deliverables).outputs as unknown[]).find(
            (o) => recordValue(o).variantId === node.variantId,
          )
        : null,
    ).spaceId,
  )
  if (!spaceId) {
    throw new Error('上游节点缺少 spaceId（分空间谱系）')
  }

  const sourceUrl = pickString(node.url)
  if (!sourceUrl) throw new Error('上游节点缺少图片')
  const sourceFile = await fetchArtifactAsFile(
    sourceUrl,
    `${kind}-source`,
  )
  const semantic = await resolveSemanticLayout(node.assetId)

  const form = new FormData()
  form.append('source_space_image', sourceFile)
  form.append('source_approved', 'true')
  form.append('semantic_layout', semantic)
  form.append('space_id', spaceId)
  form.append('asset_parent_id', node.assetId)
  form.append('source_space_version_id', versionId)
  form.append('project_id', projectId)

  if (kind === 'style') {
    const allowed = new Set<string>(STYLE_SCHEME_VARIANTS)
    const picked = (extras?.selectedVariants || []).filter((id) =>
      allowed.has(id),
    )
    const variants = picked.length
      ? picked
      : [...STYLE_SCHEME_VARIANTS]
    form.append('variants', variants.join(','))
    if (designPrompt) form.append('design_prompt', designPrompt)
    return postAndPoll(createStyleSchemeRenders(form), onJob, signal)
  }
  if (kind === 'tone') {
    const allowed = new Set<string>(TONE_SCHEME_VARIANTS)
    const picked = (extras?.selectedVariants || []).filter((id) =>
      allowed.has(id),
    )
    const variants = picked.length ? picked : [...TONE_SCHEME_VARIANTS]
    form.append('variants', variants.join(','))
    if (designPrompt) form.append('design_prompt', designPrompt)
    return postAndPoll(createToneSchemeRenders(form), onJob, signal)
  }
  if (!extras?.markFile) throw new Error('请绘制红色闭合标注')
  if (!extras.editPrompt?.trim()) throw new Error('请填写局部修改说明')
  form.append('mark_image', extras.markFile)
  form.append('edit_prompt', extras.editPrompt.trim())
  return postAndPoll(createLocalEditRender(form), onJob, signal)
}

export type Stage01ApprovalPayload = {
  approvedLayoutImage: File
  semanticLayout: Record<string, unknown> | string
  planWidthMm: number
  planDepthMm: number
  analysisJobId: string
  approvedLayoutVersionId: string
  sourceSha256?: string
  detectedBounds: { x: number; y: number; width: number; height: number }
}

export type CanvasActionExtras = {
  designPrompt?: string
  file?: File
  selectedSpaceIds?: string[]
  /** 风格方案勾选的 variant id */
  selectedStyleVariants?: string[]
  /** 色调方案勾选的 variant id */
  selectedToneVariants?: string[]
  /** 轴侧方案勾选的 variant id */
  selectedAxonometricVariants?: string[]
  markFile?: File
  editPrompt?: string
  planWidthMm?: number
  planDepthMm?: number
  /** 01 结构编辑器确认结果；生成布局必填 */
  stage01Approval?: Stage01ApprovalPayload
  /** 已通过拖把线/生成对话框确认，可直接提交派生任务 */
  spawnDialogConfirmed?: boolean
  /** @deprecated 使用 spawnDialogConfirmed */
  layoutDialogConfirmed?: boolean
  /** @deprecated 使用 spawnDialogConfirmed */
  colorPlanDialogConfirmed?: boolean
}

/**
 * 执行画布动作。若需要额外 UI 输入，抛出带 code=NEED_PANEL 的错误，
 * 或返回 panel 请求（通过 onNeedPanel）。
 */
export async function executeCanvasAction(params: {
  projectId: string
  node: CanvasGraphNode | null
  action: string
  extras?: CanvasActionExtras
  onJob?: JobListener
  signal?: AbortSignal
  onNeedPanel?: (panel: StagePanelRequest) => void
}): Promise<{ ok: true; message: string; job?: Job } | { ok: false; needPanel: StagePanelRequest }> {
  const { projectId, node, action, extras, onJob, signal, onNeedPanel } = params

  if (action === 'upload_floorplan' || (action === 'reanalyze' && !extras?.file)) {
    const panel: StagePanelRequest = { kind: 'upload_floorplan' }
    onNeedPanel?.(panel)
    return { ok: false, needPanel: panel }
  }

  if (action === 'reanalyze' || action === 'upload_floorplan_submit') {
    if (!extras?.file) throw new Error('请选择户型图')
    const job = await runFloorplanAnalyze({
      projectId,
      file: extras.file,
      planWidthMm: extras.planWidthMm,
      planDepthMm: extras.planDepthMm,
      onJob,
      signal,
    })
    return { ok: true, message: `户型识别完成：${job.status}`, job }
  }

  if (!node) throw new Error('请先选择节点')

  if (action === 'open_full') {
    return { ok: true, message: 'open_full' }
  }
  if (action === 'download') {
    return { ok: true, message: 'download' }
  }

  if (action === 'approve' || action === 'set_baseline') {
    if (!node.assetId || !node.variantId) throw new Error('节点不可批准')
    const result = await approveVariantIdempotent({
      assetId: node.assetId,
      variantId: node.variantId,
      comment: action === 'set_baseline' ? '画布设为基准' : '画布批准',
    })
    return {
      ok: true,
      message: result.reused
        ? `已是批准状态：${node.variantId}`
        : `已批准：${node.variantId}`,
    }
  }

  if (action === 'unapprove') {
    if (!node.assetId || !node.variantId) throw new Error('节点不可取消批准')
    await unapproveVariant({
      assetId: node.assetId,
      variantId: node.variantId,
      comment: '画布取消批准',
    })
    return {
      ok: true,
      message: `已取消批准：${node.variantId}`,
    }
  }

  if (action === 'retry' && node.jobId) {
    const response = await retryJob(node.jobId)
    if (!response.ok) throw new Error(`重试失败：${response.status}`)
    const job = (await response.json()) as Job
    onJob?.(job)
    const completed = await pollJob(job.id, onJob, undefined, signal)
    return { ok: true, message: `重试结束：${completed.status}`, job: completed }
  }

  if (action === 'generate_layout') {
    const job = await runLayoutFromFloorplan(
      projectId,
      node,
      extras?.designPrompt || '',
      extras?.stage01Approval,
      onJob,
      signal,
    )
    return { ok: true, message: '布局生成完成', job }
  }

  if (action === 'generate_color_plan') {
    const job = await runColorPlan(
      projectId,
      node,
      extras?.designPrompt || '',
      onJob,
      signal,
    )
    return { ok: true, message: '彩平生成完成', job }
  }

  if (action === 'generate_axonometric') {
    if (!extras?.selectedAxonometricVariants?.length) {
      const panel: StagePanelRequest = {
        kind: 'axonometric_select',
        options: AXONOMETRIC_VARIANTS.map((id) => ({
          id,
          name: AXONOMETRIC_VARIANT_LABELS[id] || id,
        })),
      }
      onNeedPanel?.(panel)
      return { ok: false, needPanel: panel }
    }
    const job = await runAxonometricOrSpace(
      projectId,
      node,
      'axonometric',
      extras?.designPrompt || '',
      undefined,
      onJob,
      signal,
      extras.selectedAxonometricVariants,
    )
    return { ok: true, message: '轴侧生成完成', job }
  }

  if (action === 'generate_space_render') {
    if (!extras?.selectedSpaceIds) {
      // 解析房间列表
      if (!node.assetId) throw new Error('缺少资产')
      let semantic = ''
      try {
        semantic = await resolveSemanticLayout(node.assetId)
      } catch {
        const lineage = await resolveLayoutLineage(node.assetId)
        semantic = lineage.semantic
      }
      const rooms = roomsFromSemantic(semantic)
      if (!rooms.length) throw new Error('语义中没有房间，无法生成分空间')
      const panel: StagePanelRequest = { kind: 'space_select', rooms }
      onNeedPanel?.(panel)
      return { ok: false, needPanel: panel }
    }
    const job = await runAxonometricOrSpace(
      projectId,
      node,
      'space_render',
      extras?.designPrompt || '',
      extras.selectedSpaceIds,
      onJob,
      signal,
    )
    return { ok: true, message: '分空间生成完成', job }
  }

  if (action === 'generate_style_scheme') {
    if (!extras?.selectedStyleVariants?.length) {
      const panel: StagePanelRequest = {
        kind: 'style_select',
        options: STYLE_SCHEME_VARIANTS.map((id) => ({
          id,
          name: STYLE_SCHEME_VARIANT_LABELS[id] || id,
        })),
      }
      onNeedPanel?.(panel)
      return { ok: false, needPanel: panel }
    }
    const job = await runDerivative(
      projectId,
      node,
      'style',
      extras?.designPrompt || '',
      { selectedVariants: extras.selectedStyleVariants },
      onJob,
      signal,
    )
    return { ok: true, message: '风格方案生成完成', job }
  }

  if (action === 'generate_tone_scheme') {
    if (!extras?.selectedToneVariants?.length) {
      const panel: StagePanelRequest = {
        kind: 'tone_select',
        options: TONE_SCHEME_VARIANTS.map((id) => ({
          id,
          name: TONE_SCHEME_VARIANT_LABELS[id] || id,
        })),
      }
      onNeedPanel?.(panel)
      return { ok: false, needPanel: panel }
    }
    const job = await runDerivative(
      projectId,
      node,
      'tone',
      extras?.designPrompt || '',
      { selectedVariants: extras.selectedToneVariants },
      onJob,
      signal,
    )
    return { ok: true, message: '色调方案生成完成', job }
  }

  if (action === 'local_edit') {
    if (!extras?.markFile || !extras.editPrompt) {
      if (!node.assetId || !node.url) throw new Error('色调节点缺少图片')
      // 确保有 version
      let versionId = pickString(node.approvedVersionId)
      if (!versionId && node.variantId) {
        const approved = await approveVariantIdempotent({
          assetId: node.assetId,
          variantId: node.variantId,
        })
        versionId = approved.approvedVersionId
      }
      const asset = await fetchAsset(node.assetId)
      const metadata = recordValue(asset.metadata)
      const spaceId = pickString(metadata.spaceId) || 'room_living'
      const panel: StagePanelRequest = {
        kind: 'local_edit',
        sourceUrl: node.url,
        spaceId,
        assetId: node.assetId,
        versionId: versionId || '',
      }
      onNeedPanel?.(panel)
      return { ok: false, needPanel: panel }
    }
    const job = await runDerivative(
      projectId,
      node,
      'local_edit',
      '',
      { markFile: extras.markFile, editPrompt: extras.editPrompt },
      onJob,
      signal,
    )
    return { ok: true, message: '局部修改完成', job }
  }

  if (action === 'view_structure') {
    return { ok: true, message: 'view_structure' }
  }

  if (action === 'copy_node' || action === 'duplicate' || action === 'delete') {
    return {
      ok: true,
      message:
        action === 'delete'
          ? '删除仅软删画布坐标节点（资产保留）'
          : '复制/副本将接入 canvas_nodes CRUD',
    }
  }

  throw new Error(`未实现的操作：${action}`)
}

export { roomsFromSemantic, cancelJob }
