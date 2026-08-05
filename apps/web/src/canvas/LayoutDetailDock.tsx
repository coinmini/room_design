import { assetUrl } from '../api'
import { stageDetailMeta, type StageDeriveAction } from './stageDetail'
import type { CanvasGraphNode } from './types'
import { normalizeStage } from './types'
import './theme.css'

export type StageDetailPrimaryAction = StageDeriveAction & {
  key?: string
  disabled?: boolean
  onClick: () => void
}

type Props = {
  node: CanvasGraphNode
  busy?: boolean
  onBack: () => void
  onApprove: () => void
  primaryActions: StageDetailPrimaryAction[]
  onOpenFull: () => void
  onDownload: () => void
}

/**
 * 02–08 图片阶段详情坞：展示当前节点图，支持批准与下游派生。
 * 不是 01 结构编辑器。
 */
export default function LayoutDetailDock({
  node,
  busy,
  onBack,
  onApprove,
  primaryActions,
  onOpenFull,
  onDownload,
}: Props) {
  const stage = normalizeStage(node)
  const meta = stageDetailMeta(stage)

  const imageUrl = assetUrl(node.url || node.thumbnailUrl || undefined)
  const title = (
    node.label ||
    node.variantId ||
    node.title ||
    '方案'
  ).replaceAll('_', ' ')
  const approved = Boolean(node.approved || node.approvalStatus === 'approved')

  return (
    <div className="canvas-structure-dock canvas-layout-detail-dock">
      <aside className="canvas-structure-rail">
        <div className="canvas-structure-rail-title">画布上下文</div>
        <div
          className="canvas-pill"
          style={{ width: '100%', justifyContent: 'center' }}
        >
          {meta.pill}
        </div>
        <p className="canvas-secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
          {meta.description}
        </p>
        {imageUrl ? (
          <img className="canvas-structure-thumb" src={imageUrl} alt="" />
        ) : null}
        <div className="canvas-layout-detail-meta">
          <div>
            <span className="canvas-muted">方案</span>
            <strong>{title}</strong>
          </div>
          {node.assetId ? (
            <div>
              <span className="canvas-muted">资产</span>
              <code>{node.assetId.slice(0, 14)}…</code>
            </div>
          ) : null}
          {meta.showApprove ? (
            <div>
              <span className="canvas-muted">状态</span>
              <strong
                style={{ color: approved ? 'var(--canvas-success)' : undefined }}
              >
                {approved ? '✓ 已批准' : '待批准'}
              </strong>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          className="canvas-btn"
          style={{ width: '100%' }}
          onClick={onBack}
          disabled={busy}
        >
          ← 返回图谱
        </button>
        <p className="canvas-muted" style={{ fontSize: 11 }}>
          Esc 也可返回
        </p>
      </aside>

      <div className="canvas-layout-detail-main">
        <header className="canvas-layout-detail-header canvas-oneline-header">
          <div className="canvas-oneline-header-left">
            <span className="canvas-oneline-kicker">{meta.code}</span>
            <h2 className="canvas-oneline-title" title={title}>
              {title}
            </h2>
          </div>
          <div className="canvas-oneline-header-actions">
            <button
              type="button"
              className="canvas-btn canvas-topbar-btn"
              onClick={onOpenFull}
              disabled={!imageUrl || busy}
            >
              原图
            </button>
            <button
              type="button"
              className="canvas-btn canvas-topbar-btn"
              onClick={onDownload}
              disabled={!imageUrl || busy}
            >
              下载
            </button>
            {meta.showApprove ? (
              <button
                type="button"
                className="canvas-btn canvas-topbar-btn"
                onClick={onApprove}
                disabled={!node.assetId || !node.variantId || busy}
              >
                {approved ? '再批准' : '批准'}
              </button>
            ) : null}
            {primaryActions.map((action) => (
              <button
                key={action.key ?? action.action}
                type="button"
                className={
                  action.primary
                    ? 'canvas-btn canvas-btn-primary canvas-topbar-btn'
                    : 'canvas-btn canvas-topbar-btn'
                }
                onClick={action.onClick}
                disabled={action.disabled || busy}
              >
                {busy ? '处理中…' : action.label}
              </button>
            ))}
          </div>
        </header>

        <div className="canvas-layout-detail-stage">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={title}
              className="canvas-layout-detail-image"
            />
          ) : (
            <div className="canvas-layout-detail-empty">
              当前节点没有可显示的图片 URL
            </div>
          )}
        </div>

        <footer className="canvas-layout-detail-footer canvas-secondary">
          {meta.footer}
        </footer>
      </div>
    </div>
  )
}
