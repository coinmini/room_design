import { useMemo, useState } from 'react'

import {
  apiFetch,
  approveWorkflowAsset,
  assetUrl,
  type SceneAsset,
  type SceneAssetDetail,
} from '../api'

export type WorkflowAssetPickerStage =
  | 'color_plan'
  | 'axonometric'
  | 'space_render'
  | 'style'
  | 'tone'
  | 'local_edit'

export type WorkflowResumeBundle = {
  assetId: string
  jobId: string
  projectId?: string | null
  parentAssetId?: string | null
  moduleKey: string
  workflowStage: string
  approvalStatus: string
  approvedVariantId: string
  approvedVersionId: string
  approvedLayoutVersionId?: string | null
  approvedOutputUrl: string
  semanticLayout: Record<string, unknown>
  approvedLayoutAssetId?: string | null
  approvedLayoutImageUrl?: string | null
  approvedColorPlanAssetId?: string | null
  approvedColorPlanVersionId?: string | null
  approvedColorPlanImageUrl?: string | null
  sourceSpaceImageUrl?: string | null
  spaceId?: string | null
  spaceName?: string | null
  eligibleNextStages: string[]
  lineage?: Record<string, unknown>
}

type PickerRequirement = {
  moduleKey: 'layout' | 'ai_workflow'
  workflowStage?: string
  title: string
  description: string
  emptyHint: string
  /** Stages 06~08 may also pick a generated-but-not-yet-approved asset; the
   * picker then approves the chosen variant on the fly before resuming. */
  allowGenerated?: boolean
}

const pickerRequirements: Record<WorkflowAssetPickerStage, PickerRequirement> = {
  color_plan: {
    moduleKey: 'layout',
    title: '选择已批准的平面布局',
    description: '同时恢复布局图片、SemanticLayout 和布局版本谱系。',
    emptyHint: '“我的资产”中还没有已批准的阶段 02 平面布局。',
  },
  axonometric: {
    moduleKey: 'ai_workflow',
    workflowStage: 'color_plan',
    title: '选择已批准的彩平方案',
    description: '同时恢复彩平、平面布局、SemanticLayout 和审批版本。',
    emptyHint: '“我的资产”中还没有已批准的阶段 03 彩平方案。',
  },
  space_render: {
    moduleKey: 'ai_workflow',
    workflowStage: 'color_plan',
    title: '选择已批准的彩平方案',
    description: '同时恢复彩平、平面布局、SemanticLayout 和审批版本。',
    emptyHint: '“我的资产”中还没有已批准的阶段 03 彩平方案。',
  },
  style: {
    moduleKey: 'ai_workflow',
    workflowStage: 'space_render',
    title: '选择空间效果图作为基准',
    description:
      '恢复阶段 05 的空间、构图、SemanticLayout 和审批版本；未批准的生成图也可以在选定方案后一键批准并载入。',
    emptyHint: '“我的资产”中还没有阶段 05 空间效果图。',
    allowGenerated: true,
  },
  tone: {
    moduleKey: 'ai_workflow',
    workflowStage: 'style_scheme',
    title: '选择风格方案作为基准',
    description:
      '恢复阶段 06 的同空间风格基准及完整版本谱系；未批准的生成图也可以在选定方案后一键批准并载入。',
    emptyHint: '“我的资产”中还没有阶段 06 风格方案。',
    allowGenerated: true,
  },
  local_edit: {
    moduleKey: 'ai_workflow',
    workflowStage: 'tone_scheme',
    title: '选择色调方案作为基准',
    description:
      '恢复阶段 07 的同空间色调基准及完整版本谱系；未批准的生成图也可以在选定方案后一键批准并载入。',
    emptyHint: '“我的资产”中还没有阶段 07 色调方案。',
    allowGenerated: true,
  },
}

function valueRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function valueString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function isApprovedAsset(asset: SceneAsset): boolean {
  const metadata = valueRecord(asset.metadata)
  const deliverables = valueRecord(asset.deliverables)
  return (
    valueString(metadata, 'approvalStatus', 'approval_status') === 'approved' &&
    Boolean(
      valueString(metadata, 'approvedVariantId', 'approved_variant_id') ??
        valueString(deliverables, 'approvedVariantId', 'approved_variant_id'),
    )
  )
}

function formatAssetTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

type VariantChoice = {
  variantId: string
  url: string
  label: string
}

async function readErrorDetail(response: Response, fallback: string): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as {
    detail?: unknown
  } | null
  return new Error(
    typeof payload?.detail === 'string' ? payload.detail : fallback,
  )
}

function succeededVariantChoices(detail: SceneAssetDetail): VariantChoice[] {
  const outputs = detail.sourceResult.outputs
  if (!Array.isArray(outputs)) return []
  return outputs.flatMap((value) => {
    if (!value || typeof value !== 'object') return []
    const record = value as Record<string, unknown>
    const variantId = typeof record.variantId === 'string' ? record.variantId : ''
    const url = typeof record.url === 'string' ? record.url : ''
    if (!variantId || !url || record.status !== 'succeeded') return []
    const label =
      (typeof record.label === 'string' && record.label) ||
      variantId.replaceAll('_', ' ')
    return [{ variantId, url, label }]
  })
}

export default function WorkflowAssetPicker({
  stage,
  selectedAssetId,
  onSelect,
}: {
  stage: WorkflowAssetPickerStage
  selectedAssetId?: string
  onSelect: (bundle: WorkflowResumeBundle) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [assets, setAssets] = useState<SceneAsset[]>([])
  const [loading, setLoading] = useState(false)
  const [selectingId, setSelectingId] = useState('')
  const [error, setError] = useState('')
  const [pendingVariants, setPendingVariants] = useState<{
    asset: SceneAsset
    outputs: VariantChoice[]
  } | null>(null)
  const requirement = pickerRequirements[stage]

  const visibleAssets = useMemo(() => {
    const values = requirement.allowGenerated
      ? assets
      : assets.filter(isApprovedAsset)
    return [...values].sort(
      (a, b) => Number(isApprovedAsset(b)) - Number(isApprovedAsset(a)),
    )
  }, [assets, requirement])

  const loadAssets = async () => {
    setLoading(true)
    setError('')
    try {
      const query = new URLSearchParams({
        limit: '100',
        moduleKey: requirement.moduleKey,
      })
      if (requirement.workflowStage) {
        query.set('workflowStage', requirement.workflowStage)
      }
      const response = await apiFetch(`/v1/assets?${query.toString()}`, {
        cache: 'no-store',
      })
      if (!response.ok) {
        throw await readErrorDetail(response, `资产列表加载失败：${response.status}`)
      }
      setAssets((await response.json()) as SceneAsset[])
    } catch (value) {
      setError(value instanceof Error ? value.message : '资产列表加载失败')
    } finally {
      setLoading(false)
    }
  }

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    setPendingVariants(null)
    if (next) void loadAssets()
  }

  const resumeAsset = async (assetId: string) => {
    const response = await apiFetch(
      `/v1/assets/${encodeURIComponent(assetId)}/workflow-resume`,
      { cache: 'no-store' },
    )
    if (!response.ok) {
      throw await readErrorDetail(response, `资产详情加载失败：${response.status}`)
    }
    await onSelect((await response.json()) as WorkflowResumeBundle)
    setExpanded(false)
    setPendingVariants(null)
  }

  const approveAndResume = async (assetId: string, variantId: string) => {
    const approvalResponse = await approveWorkflowAsset(assetId, {
      variantId,
      comment: '在工作流中从“我的资产”选择该方案作为后续阶段基准。',
    })
    if (!approvalResponse.ok) {
      throw await readErrorDetail(
        approvalResponse,
        `批准所选方案失败：${approvalResponse.status}`,
      )
    }
    await resumeAsset(assetId)
  }

  const chooseAsset = async (asset: SceneAsset) => {
    if (selectingId) return
    setSelectingId(asset.id)
    setError('')
    setPendingVariants(null)
    try {
      if (isApprovedAsset(asset) || !requirement.allowGenerated) {
        await resumeAsset(asset.id)
        return
      }
      const response = await apiFetch(
        `/v1/assets/${encodeURIComponent(asset.id)}`,
        { cache: 'no-store' },
      )
      if (!response.ok) {
        throw await readErrorDetail(response, `资产详情加载失败：${response.status}`)
      }
      const outputs = succeededVariantChoices(
        (await response.json()) as SceneAssetDetail,
      )
      if (!outputs.length) {
        throw new Error('该资产没有可用的成功图片，不能作为基准。')
      }
      if (outputs.length === 1) {
        await approveAndResume(asset.id, outputs[0].variantId)
        return
      }
      // Several generated candidates: let the user pick the exact image first.
      setPendingVariants({ asset, outputs })
    } catch (value) {
      setError(value instanceof Error ? value.message : '资产恢复失败')
    } finally {
      setSelectingId('')
    }
  }

  const chooseVariant = async (variantId: string) => {
    if (selectingId || !pendingVariants) return
    const key = `${pendingVariants.asset.id}:${variantId}`
    setSelectingId(key)
    setError('')
    try {
      await approveAndResume(pendingVariants.asset.id, variantId)
    } catch (value) {
      setError(value instanceof Error ? value.message : '批准所选方案失败')
    } finally {
      setSelectingId('')
    }
  }

  return (
    <section className="workflow-asset-picker">
      <button
        type="button"
        className="workflow-asset-picker-trigger"
        aria-expanded={expanded}
        onClick={toggle}
      >
        <span>MY ASSETS</span>
        <strong>从“我的资产”选择必需素材</strong>
        <small>{selectedAssetId ? `当前来源 · ${selectedAssetId.slice(-8)}` : requirement.title}</small>
      </button>

      {expanded && (
        <div className="workflow-asset-picker-panel">
          <header>
            <div>
              <strong>{requirement.title}</strong>
              <p>{requirement.description}</p>
            </div>
            <button type="button" onClick={() => setExpanded(false)}>
              关闭
            </button>
          </header>

          {loading ? (
            <div className="workflow-asset-picker-state">正在读取个人资产…</div>
          ) : visibleAssets.length ? (
            <div className="workflow-asset-picker-grid">
              {visibleAssets.map((asset) => {
                const metadata = valueRecord(asset.metadata)
                const approved = isApprovedAsset(asset)
                const approvedVariantId =
                  valueString(metadata, 'approvedVariantId', 'approved_variant_id') ??
                  ''
                const isSelected = selectedAssetId === asset.id
                return (
                  <button
                    type="button"
                    key={asset.id}
                    className={isSelected ? 'selected' : ''}
                    disabled={Boolean(selectingId)}
                    onClick={() => void chooseAsset(asset)}
                  >
                    {asset.thumbnailUrl ? (
                      <img src={assetUrl(asset.thumbnailUrl)} alt="" />
                    ) : (
                      <span className="workflow-asset-picker-placeholder">ASSET</span>
                    )}
                    <div>
                      <strong>{asset.title}</strong>
                      <span>
                        {approved
                          ? approvedVariantId.replaceAll('_', ' ')
                          : '生成图片 · 未批准'}
                      </span>
                      <small>
                        {formatAssetTime(asset.createdAt)} · {asset.id.slice(-8)}
                      </small>
                    </div>
                    <i>
                      {selectingId === asset.id
                        ? '恢复中…'
                        : isSelected
                          ? '✓ 已载入'
                          : approved
                            ? '选择并恢复'
                            : '选择方案'}
                    </i>
                    <em
                      className={`workflow-asset-picker-badge ${approved ? 'approved' : 'generated'}`}
                    >
                      {approved ? '已批准' : '未批准'}
                    </em>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="workflow-asset-picker-state">
              <strong>没有可用的素材</strong>
              <span>{requirement.emptyHint}</span>
            </div>
          )}

          {pendingVariants && (
            <div className="workflow-asset-picker-variants">
              <header>
                <strong>选择要用作基准的方案图</strong>
                <p>
                  该资产尚未批准；点击下方任意一张方案图，系统会先批准该方案再载入为当前阶段基准。
                </p>
              </header>
              <div className="workflow-asset-picker-grid">
                {pendingVariants.outputs.map((output) => {
                  const key = `${pendingVariants.asset.id}:${output.variantId}`
                  return (
                    <button
                      type="button"
                      key={output.variantId}
                      disabled={Boolean(selectingId)}
                      onClick={() => void chooseVariant(output.variantId)}
                    >
                      <img src={assetUrl(output.url)} alt={output.label} />
                      <div>
                        <strong>{output.label}</strong>
                      </div>
                      <i>
                        {selectingId === key ? '批准并载入…' : '批准并用作基准'}
                      </i>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {error && <p className="workflow-asset-picker-error">{error}</p>}
        </div>
      )}
    </section>
  )
}
