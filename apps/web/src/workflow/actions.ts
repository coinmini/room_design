/**
 * W3-1：生成 / 审批 / 设基准的纯函数模块。
 * 不依赖 activeStage；调用方显式传入 sourceAssetId / variantId / versionId / spaceId。
 */

import {
  approveWorkflowAsset,
  apiFetch,
  createAxonometricRenders,
  createColorPlanRenders,
  createLocalEditRender,
  createSpaceRenders,
  createStyleSchemeRenders,
  createToneSchemeRenders,
  pollJob,
  type Job,
} from '../api'

export type WorkflowStageKey =
  | 'color_plan'
  | 'axonometric'
  | 'space_render'
  | 'style'
  | 'tone'
  | 'local_edit'

export type ApproveParams = {
  assetId: string
  variantId: string
  comment?: string
}

export type BaselineParams = {
  assetId: string
  variantId: string
  url: string
  spaceId: string
  stage: 'space_render' | 'style' | 'tone'
  label?: string
  file: File
  comment?: string
}

export type VisualBaseline = {
  stage: 'space_render' | 'style' | 'tone'
  file: File
  url: string
  assetId: string
  approvedVersionId: string
  variantId: string
  label: string
  spaceId: string
}

export type GenerateParams = {
  stage: WorkflowStageKey
  form: FormData
  signal?: AbortSignal
  onJob?: (job: Job) => void
  mergePrevious?: Job
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function apiError(detail: unknown, status: number): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        typeof item === 'object' && item && 'msg' in item
          ? String((item as { msg: unknown }).msg)
          : String(item),
      )
      .join('; ')
  }
  return `请求失败：${status}`
}

/** 审批指定资产的某个 variant（与 activeStage 无关）。 */
export async function approveVariant(params: ApproveParams): Promise<{
  assetId: string
  approvedVariantId: string
  approvedVersionId: string
  raw: Record<string, unknown>
}> {
  const response = await approveWorkflowAsset(params.assetId, {
    variantId: params.variantId,
    comment: params.comment,
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: unknown
    } | null
    throw new Error(apiError(payload?.detail, response.status))
  }
  const approval = recordValue(await response.json())
  const approvedAsset = recordValue(approval.asset)
  const metadata = recordValue(approval.metadata)
  const deliverables = recordValue(approval.deliverables)
  const assetId = String(
    approval.assetId ?? approval.id ?? approvedAsset.id ?? params.assetId,
  )
  const approvedVersionId = String(
    metadata.approvedVersionId ?? deliverables.approvedVersionId ?? '',
  )
  return {
    assetId,
    approvedVariantId: params.variantId,
    approvedVersionId,
    raw: approval,
  }
}

/**
 * 设基准：批准 variant 并返回 VisualBaseline。
 * W3-3：调用方负责更新本地 baseline 状态；**不得**在此删除下游 job / 跳阶段。
 */
export async function setBaselineFromOutput(
  params: BaselineParams,
): Promise<VisualBaseline> {
  const approval = await approveVariant({
    assetId: params.assetId,
    variantId: params.variantId,
    comment:
      params.comment ??
      `阶段 ${params.stage} 已由用户批准为下一阶段视觉基准。`,
  })
  if (!approval.approvedVersionId) {
    throw new Error('审批结果缺少 approvedVersionId，无法建立后续谱系。')
  }
  return {
    stage: params.stage,
    file: params.file,
    url: params.url,
    assetId: approval.assetId,
    approvedVersionId: approval.approvedVersionId,
    variantId: params.variantId,
    label: params.label ?? params.variantId,
    spaceId: params.spaceId,
  }
}

function stageRequest(stage: WorkflowStageKey, form: FormData): Promise<Response> {
  switch (stage) {
    case 'color_plan':
      return createColorPlanRenders(form)
    case 'axonometric':
      return createAxonometricRenders(form)
    case 'space_render':
      return createSpaceRenders(form)
    case 'style':
      return createStyleSchemeRenders(form)
    case 'tone':
      return createToneSchemeRenders(form)
    case 'local_edit':
      return createLocalEditRender(form)
  }
}

/** 生成任务：显式 stage + form，不读 activeStage。 */
export async function runGeneration(params: GenerateParams): Promise<Job> {
  const response = await stageRequest(params.stage, params.form)
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: unknown
    } | null
    throw new Error(apiError(payload?.detail, response.status))
  }
  const created = (await response.json()) as Job
  params.onJob?.(created)
  const completed = await pollJob(
    created.id,
    params.onJob,
    undefined,
    params.signal,
  )
  params.onJob?.(completed)
  return completed
}

export async function fetchAssetDetail(assetId: string): Promise<Record<string, unknown>> {
  const response = await apiFetch(`/v1/assets/${encodeURIComponent(assetId)}`, {
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new Error(`读取资产失败：${response.status}`)
  }
  return recordValue(await response.json())
}

/** 若资产已批准同一 variant，则复用，避免无谓 409。 */
export async function approveVariantIdempotent(
  params: ApproveParams,
): Promise<{
  assetId: string
  approvedVariantId: string
  approvedVersionId: string
  reused: boolean
  raw: Record<string, unknown>
}> {
  try {
    const existing = await fetchAssetDetail(params.assetId)
    const metadata = recordValue(existing.metadata)
    const deliverables = recordValue(existing.deliverables)
    const existingVariant = String(
      metadata.approvedVariantId ?? deliverables.approvedVariantId ?? '',
    )
    if (
      metadata.approvalStatus === 'approved' &&
      existingVariant === params.variantId
    ) {
      return {
        assetId: String(existing.id ?? params.assetId),
        approvedVariantId: params.variantId,
        approvedVersionId: String(
          metadata.approvedVersionId ?? deliverables.approvedVersionId ?? '',
        ),
        reused: true,
        raw: existing,
      }
    }
  } catch {
    // fall through to approve
  }
  const result = await approveVariant(params)
  return { ...result, reused: false }
}
