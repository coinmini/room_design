import { useState } from 'react'

import {
  apiFetch,
  approveWorkflowAsset,
  assetUrl,
  pollJob,
  type Job,
  type SceneAssetDetail,
} from '../api'
import { BatchProgress } from '../BatchProgress'
import type { FloorplanStage01Approval } from '../FloorplanModule'

type AiLayoutItem = {
  layoutId: string
  layoutVersion?: number
  strategy: string
  previewUrl: string
  generationMode: 'ai_image'
  provider: string
  model: string
  notice: string
  isConceptOnly: true
  constructionReady: false
  requiresUserConfirmation: true
}

type AiLayoutResult = {
  assetId?: string
  generationMode: 'ai_image'
  provider: string
  model: string
  notice: string
  sourceMode: 'stage01_confirmed_annotation'
  isConceptOnly: true
  constructionReady: false
  requiresUserConfirmation: true
  layouts: AiLayoutItem[]
}

export type ApprovedLayoutSelection = {
  file: File
  previewUrl: string
  assetId: string
  layoutId: string
  versionId: string
}

type AiLayoutStageProps = {
  sourceImage?: File | null
  semanticLayout?: string
  defaultWidthMm?: number
  defaultDepthMm?: number
  projectId?: string
  stageOneApproval?: FloorplanStage01Approval | null
  onApproved?: (selection: ApprovedLayoutSelection) => void
  onApprovalInvalidated?: () => void
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : '任务执行失败'
}

function responseError(detail: unknown, status: number): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        item && typeof item === 'object' && 'msg' in item
          ? String(item.msg)
          : String(item),
      )
      .join('；')
  }
  return `请求失败：${status}`
}

export default function AiLayoutStage({
  sourceImage = null,
  semanticLayout = '',
  defaultWidthMm = 8150,
  defaultDepthMm = 6060,
  projectId = '',
  stageOneApproval = null,
  onApproved,
  onApprovalInvalidated,
}: AiLayoutStageProps) {
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [aiRoomType, setAiRoomType] = useState('whole_home')
  const [count, setCount] = useState(2)
  const [designPrompt, setDesignPrompt] = useState(
    '保持阶段 01 的轮廓、功能区、墙体、门窗、院落和车库不变，整理成专业黑白平面布局图，并补充合理的家具、洁具、柜体、绿化与铺装。',
  )
  const [approvingLayoutId, setApprovingLayoutId] = useState('')
  const [approvedLayoutId, setApprovedLayoutId] = useState('')
  const [approvalNotice, setApprovalNotice] = useState('')

  const result = job?.result as AiLayoutResult | null
  const effectiveSourceImage = sourceImage
  const layouts = Array.isArray(result?.layouts) ? result.layouts : []

  const resetDraftResult = () => {
    if (approvedLayoutId) onApprovalInvalidated?.()
    setJob(null)
    setError('')
    setApprovedLayoutId('')
    setApprovalNotice('')
  }

  const run = async (request: Promise<Response>) => {
    if (approvedLayoutId) onApprovalInvalidated?.()
    setBusy(true)
    setError('')
    setJob(null)
    setApprovedLayoutId('')
    setApprovalNotice('')
    try {
      const response = await request
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          detail?: unknown
        } | null
        throw new Error(responseError(payload?.detail, response.status))
      }
      const created = (await response.json()) as Job
      setJob(created)
      const completed = await pollJob(created.id, setJob)
      setJob(completed)
      if (completed.status === 'FAILED') {
        setError(completed.errorMessage ?? 'AI 平面布局生成失败')
      }
    } catch (value) {
      setError(errorMessage(value))
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const form = new FormData()
    if (effectiveSourceImage) form.append('source_image', effectiveSourceImage)
    form.append('room_type', aiRoomType)
    form.append('count', String(count))
    form.append('design_prompt', designPrompt)
    if (semanticLayout.trim()) form.append('semantic_layout', semanticLayout.trim())
    if (stageOneApproval) {
      form.append('stage01_analysis_job_id', stageOneApproval.analysisJobId)
      form.append(
        'stage01_approved_version_id',
        stageOneApproval.approvedLayoutVersionId,
      )
      if (stageOneApproval.sourceSha256) {
        form.append('stage01_source_sha256', stageOneApproval.sourceSha256)
      }
      form.append(
        'stage01_detected_bounds',
        JSON.stringify(stageOneApproval.detectedBounds),
      )
    }
    if (projectId.trim()) form.append('project_id', projectId.trim())
    await run(
      apiFetch('/v1/layouts/ai', {
        method: 'POST',
        body: form,
      }),
    )
  }

  const resumeCurrentJob = async () => {
    if (!job || !['QUEUED', 'RUNNING'].includes(job.status) || busy) return
    setBusy(true)
    setError('')
    try {
      const completed = await pollJob(job.id, setJob)
      setJob(completed)
      if (completed.status === 'FAILED') {
        setError(completed.errorMessage ?? 'AI 平面布局生成失败')
      }
    } catch (value) {
      setError(errorMessage(value))
    } finally {
      setBusy(false)
    }
  }

  const approveLayout = async (layout: AiLayoutItem) => {
    const assetId = result?.assetId ?? ''
    if (!assetId) {
      setError('当前任务未返回布局资产 ID，无法持久化批准状态，请重新生成。')
      return
    }
    setApprovingLayoutId(layout.layoutId)
    setError('')
    setApprovalNotice('')
    try {
      const imageResponse = await apiFetch(layout.previewUrl)
      if (!imageResponse.ok) {
        throw new Error(`读取待批准布局图失败：${imageResponse.status}`)
      }
      const blob = await imageResponse.blob()
      const approvalResponse = await approveWorkflowAsset(assetId, {
        variantId: layout.layoutId,
        comment: '阶段 02 AI 平面布局已由用户批准为阶段 03 的视觉与家具基准。',
      })
      if (!approvalResponse.ok) {
        const payload = (await approvalResponse.json().catch(() => null)) as {
          detail?: unknown
        } | null
        throw new Error(responseError(payload?.detail, approvalResponse.status))
      }
      const approvedAsset = (await approvalResponse.json()) as SceneAssetDetail
      const approvedVariantId = String(
        approvedAsset.metadata.approvedVariantId ??
          approvedAsset.deliverables.approvedVariantId ??
          '',
      )
      if (approvedAsset.id !== assetId || approvedVariantId !== layout.layoutId) {
        throw new Error('服务端返回的批准资产或方案与当前选择不一致')
      }
      const extension = blob.type.includes('jpeg') ? 'jpg' : 'png'
      const file = new File(
        [blob],
        `approved-layout-${assetId}-${layout.layoutId}.${extension}`,
        { type: blob.type || 'image/png' },
      )
      const versionId = String(
        approvedAsset.metadata.approvedVersionId ??
          approvedAsset.deliverables.approvedVersionId ??
          `${assetId}:${layout.layoutId}:v${layout.layoutVersion ?? 1}`,
      )
      setApprovedLayoutId(layout.layoutId)
      setApprovalNotice(`已批准 ${layout.layoutId}，将作为阶段 03 的布局基准。`)
      onApproved?.({
        file,
        previewUrl: layout.previewUrl,
        assetId,
        layoutId: layout.layoutId,
        versionId,
      })
    } catch (value) {
      setError(`布局审批失败：${errorMessage(value)}`)
    } finally {
      setApprovingLayoutId('')
    }
  }

  return (
    <div className="workflow-embedded-module">
      <div className="workflow-integrated-heading">
        <div>
          <span>STAGE 02 · AI LAYOUT</span>
          <h2>AI 平面布局</h2>
          <p>继承阶段 01 的原图、尺寸和语义结构；选择并批准一个方案后自动进入彩平阶段。</p>
        </div>
        {job && <strong>{job.status}</strong>}
      </div>

      <div className="workspace layout-workspace">
        <form className="control-panel layout-control-panel" onSubmit={submit}>
          <h2>AI 平面布局生成</h2>
          <label
            className="file-drop layout-source-drop is-inherited"
          >
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled
            />
            <strong>
              {effectiveSourceImage
                ? effectiveSourceImage.name
                : '等待阶段 01 原图'}
            </strong>
            <span>
              {effectiveSourceImage
                ? '已自动继承阶段 01 原图作为结构权威'
                : '完成阶段 01 并批准后自动带入'}
            </span>
          </label>
          {semanticLayout.trim() && (
            <div className="workflow-inherited-source">
              <strong>✓ 已继承 Stage 01 SemanticLayout</strong>
              <span>房间、墙体和门窗会作为结构锁提交给图像模型。</span>
            </div>
          )}
          <label>
            设计范围
            <select
              value={aiRoomType}
              onChange={(event) => {
                resetDraftResult()
                setAiRoomType(event.target.value)
              }}
            >
              <option value="whole_home">全屋</option>
              <option value="living_room">客厅</option>
              <option value="dining_room">餐厅</option>
              <option value="bedroom">卧室</option>
            </select>
          </label>
          <div className="field-row">
            <label>
              总宽 / 开间（mm）
              <input
                type="number"
                min={2400}
                max={30000}
                disabled
                value={defaultWidthMm}
                readOnly
              />
            </label>
            <label>
              总深 / 进深（mm）
              <input
                type="number"
                min={2400}
                max={30000}
                disabled
                value={defaultDepthMm}
                readOnly
              />
            </label>
          </div>
          <label>
            候选方案数
            <select
              value={count}
              onChange={(event) => {
                resetDraftResult()
                setCount(Number(event.target.value))
              }}
            >
              <option value={1}>1 套</option>
              <option value={2}>2 套</option>
            </select>
          </label>
          <label>
            设计要求
            <textarea
              value={designPrompt}
              maxLength={500}
              onChange={(event) => {
                resetDraftResult()
                setDesignPrompt(event.target.value)
              }}
              placeholder="例如：原木风、客餐厅一体、增加收纳，保留门窗与承重墙"
            />
          </label>
          <div className="layout-output-target">
            <div>
              <span>OUTPUT TARGET</span>
              <strong>当前项目的专业黑白平面布局图</strong>
            </div>
            <p>
              只使用阶段 01 已批准的本项目原图、功能区标注与 SemanticLayout；补充家具、洁具、柜体、绿化和铺装，不发送或套用其他户型模板。
            </p>
          </div>
          <div className="constraint-list">
            <span>功能区不变</span>
            <span>院落车库保留</span>
            <span>补充家具与景观</span>
            <span>规范黑白制图</span>
          </div>
          <button
            className="primary-button"
            disabled={
              busy ||
              !effectiveSourceImage ||
              !semanticLayout.trim() ||
              !stageOneApproval ||
              !stageOneApproval.sourceSha256
            }
          >
            {busy ? 'AI 正在生成布局…' : `生成 ${count} 套专业平面布局`}
          </button>
          {!effectiveSourceImage && (
            <p className="workflow-stage-help">请先完成阶段 01。</p>
          )}
          {stageOneApproval && !stageOneApproval.sourceSha256 && (
            <p className="workflow-stage-help">
              阶段 01 缺少原图版本摘要，请重新识别并批准后再生成。
            </p>
          )}
          {job && ['QUEUED', 'RUNNING'].includes(job.status) && (
            <BatchProgress job={job} estimate="AI 布局通常需要 1-2 分钟" />
          )}
          {job && ['QUEUED', 'RUNNING'].includes(job.status) && !busy && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void resumeCurrentJob()}
            >
              继续等待当前布局任务
            </button>
          )}
          {error && <div className="notice notice-error">{error}</div>}
          {approvalNotice && (
            <div className="workflow-approval-notice">{approvalNotice}</div>
          )}
        </form>

        <section className="result-panel layout-result-panel">
          {!result && (
            <div className="empty-state">
              <span>02</span>
              <h3>等待专业平面布局生成</h3>
              <p>阶段 01 的结构和尺寸会自动带入，无需重新上传。</p>
            </div>
          )}
          {layouts.map((layout, index) => (
            <article className="layout-card ai-layout-card" key={layout.layoutId}>
              <div className="result-heading">
                <div>
                  <small>AI PLAN · {String(index + 1).padStart(2, '0')}</small>
                  <h3>专业黑白平面布局</h3>
                </div>
                <span>{layout.provider ?? result?.provider ?? 'AI IMAGE'}</span>
              </div>
              <img src={assetUrl(layout.previewUrl)} alt="AI 专业黑白平面布局" />
              <div className="ai-layout-status">
                <span>平面方案图</span>
                <span>非施工图</span>
                <span>{approvedLayoutId === layout.layoutId ? '✓ 已批准' : '需人工确认'}</span>
              </div>
              <div className="ai-layout-meta">
                <div>
                  <span>供应商</span>
                  <strong>{layout.provider ?? result?.provider ?? '未返回'}</strong>
                </div>
                <div>
                  <span>模型</span>
                  <strong>{layout.model ?? '图像生成模型'}</strong>
                </div>
                <div>
                  <span>输入</span>
                  <strong>
                    Stage 01 标注图
                  </strong>
                </div>
              </div>
              <div className="ai-layout-notice">
                <strong>方案图提醒</strong>
                <p>{layout.notice ?? result?.notice}</p>
              </div>
              <div className="ai-layout-actions">
                <button
                  type="button"
                  disabled={
                    Boolean(approvingLayoutId) ||
                    approvedLayoutId === layout.layoutId
                  }
                  onClick={() => void approveLayout(layout)}
                >
                  {approvingLayoutId === layout.layoutId
                    ? '正在批准…'
                    : approvedLayoutId === layout.layoutId
                      ? '✓ 已批准为布局基准'
                      : '批准并进入彩平'}
                </button>
                <a
                  className="ai-layout-download"
                  href={assetUrl(layout.previewUrl)}
                  target="_blank"
                  rel="noreferrer"
                  download
                >
                  下载平面布局图
                </a>
              </div>
            </article>
          ))}
        </section>
      </div>
    </div>
  )
}
