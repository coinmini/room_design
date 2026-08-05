import { assetUrl } from '../api'
import type { CanvasGraphNode } from './types'
import './theme.css'

type Props = {
  node: CanvasGraphNode
  busy?: boolean
  onBack: () => void
  onApprove: () => void
  onGenerateColorPlan: () => void
  onOpenFull: () => void
  onDownload: () => void
}

/**
 * 02 平面布局详情坞：自动展示当前节点布局图，支持批准 / 生成彩平。
 * 不是 01 结构编辑器。
 */
export default function LayoutDetailDock({
  node,
  busy,
  onBack,
  onApprove,
  onGenerateColorPlan,
  onOpenFull,
  onDownload,
}: Props) {
  const imageUrl = assetUrl(node.url || node.thumbnailUrl || undefined)
  const title =
    (node.label || node.variantId || node.title || '布局方案').replaceAll(
      '_',
      ' ',
    )
  const approved = Boolean(node.approved || node.approvalStatus === 'approved')

  return (
    <div className="canvas-structure-dock canvas-layout-detail-dock">
      <aside className="canvas-structure-rail">
        <div className="canvas-structure-rail-title">画布上下文</div>
        <div
          className="canvas-pill"
          style={{ width: '100%', justifyContent: 'center' }}
        >
          阶段 02 · 平面布局
        </div>
        <p className="canvas-secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
          已载入当前节点布局图。可批准此方案，或直接生成彩平（03）。
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
          <div>
            <span className="canvas-muted">状态</span>
            <strong style={{ color: approved ? 'var(--canvas-success)' : undefined }}>
              {approved ? '✓ 已批准' : '待批准'}
            </strong>
          </div>
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
        <header className="canvas-layout-detail-header">
          <div>
            <div className="canvas-muted" style={{ fontSize: 11, letterSpacing: '0.06em' }}>
              02 / LAYOUT DETAIL
            </div>
            <h2 style={{ margin: '4px 0 0', fontSize: 18 }}>{title}</h2>
          </div>
          <div className="canvas-toolbar">
            <button
              type="button"
              className="canvas-btn"
              onClick={onOpenFull}
              disabled={!imageUrl || busy}
            >
              打开原图
            </button>
            <button
              type="button"
              className="canvas-btn"
              onClick={onDownload}
              disabled={!imageUrl || busy}
            >
              下载
            </button>
            <button
              type="button"
              className="canvas-btn"
              onClick={onApprove}
              disabled={!node.assetId || !node.variantId || busy}
            >
              {approved ? '再次确认批准' : '批准此方案'}
            </button>
            <button
              type="button"
              className="canvas-btn canvas-btn-primary"
              onClick={onGenerateColorPlan}
              disabled={!node.assetId || busy}
            >
              {busy ? '处理中…' : '生成彩平（03）'}
            </button>
          </div>
        </header>

        <div className="canvas-layout-detail-stage">
          {imageUrl ? (
            <img src={imageUrl} alt={title} className="canvas-layout-detail-image" />
          ) : (
            <div className="canvas-layout-detail-empty">
              当前布局节点没有可显示的图片 URL
            </div>
          )}
        </div>

        <footer className="canvas-layout-detail-footer canvas-secondary">
          此图已从画布节点自动载入，无需重新上传。批准后可用于生成彩平 / 轴侧 / 分空间。
        </footer>
      </div>
    </div>
  )
}
