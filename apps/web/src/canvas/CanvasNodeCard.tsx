import type { CSSProperties } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { assetUrl } from '../api'
import type { CanvasGraphNode } from './types'
import { stageLabel, normalizeStage } from './types'
import { listNodeActions, type ActionContext } from './canRunAction'

export type CanvasNodeData = {
  graphNode: CanvasGraphNode
  selected?: boolean
  actionCtx?: ActionContext
  onAction?: (action: string, node: CanvasGraphNode) => void
  showActions?: boolean
  upstreamChanged?: boolean
}

export function CanvasNodeCard({ data, selected }: NodeProps) {
  const payload = data as unknown as CanvasNodeData
  const node = payload.graphNode
  const stage = normalizeStage(node)
  const thumb = assetUrl(node.thumbnailUrl || node.url || undefined)
  const actions = listNodeActions(node, payload.actionCtx ?? {})
  const primary = actions.filter(
    (a) =>
      [
        'view_structure',
        'generate_layout',
        'approve',
        'set_baseline',
        'generate_style_scheme',
        'generate_tone_scheme',
        'local_edit',
        'generate_color_plan',
        'generate_space_render',
        'generate_axonometric',
      ].includes(a.action),
  )

  const cardStyle: CSSProperties = {
    width: 220,
    borderRadius: 12,
    border: selected
      ? '1px solid var(--canvas-primary)'
      : '1px solid var(--canvas-border)',
    background: 'var(--canvas-card)',
    boxShadow: selected
      ? '0 0 0 1px var(--canvas-primary), 0 8px 24px rgba(59,130,246,.25)'
      : 'var(--canvas-shadow-soft)',
    overflow: 'hidden',
    color: 'var(--canvas-text)',
    fontSize: 12,
  }

  return (
    <div className="canvas-node-card" style={cardStyle}>
      <Handle type="target" position={Position.Left} style={{ opacity: 0.35 }} />
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '8px 10px',
          borderBottom: '1px solid var(--canvas-divider)',
          background: 'var(--canvas-bg-elevated)',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            className="canvas-secondary"
            style={{ fontSize: 10, letterSpacing: '0.04em' }}
          >
            {stageLabel(stage)}
          </div>
          <div
            style={{
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 140,
            }}
            title={node.title || node.label || node.variantId}
          >
            {(node.label || node.variantId || '').replaceAll('_', ' ')}
          </div>
        </div>
        {payload.actionCtx?.stage01Confirmed ? (
          <span
            className="canvas-pill"
            style={{
              background: 'var(--canvas-success-muted)',
              borderColor: 'transparent',
              color: 'var(--canvas-success)',
              height: 22,
              padding: '0 8px',
            }}
            title="结构已确认，可生成布局"
          >
            ✓ 结构已确认
          </span>
        ) : node.approved || node.approvalStatus === 'approved' ? (
          <span
            className="canvas-pill"
            style={{
              background: 'var(--canvas-success-muted)',
              borderColor: 'transparent',
              color: 'var(--canvas-success)',
              height: 22,
              padding: '0 8px',
            }}
            title="已批准 / 基准"
          >
            ✓ 已批准
          </span>
        ) : node.isTemporary ? (
          <span
            className="canvas-pill"
            style={{
              background: 'var(--canvas-warning-muted)',
              borderColor: 'transparent',
              color: 'var(--canvas-warning)',
              height: 22,
              padding: '0 8px',
            }}
          >
            {node.jobStatus === 'CANCELED' ? '已取消' : '部分结果'}
          </span>
        ) : node.isSkeleton ? (
          <span
            className="canvas-pill"
            style={{ height: 22, padding: '0 8px' }}
          >
            生成中
          </span>
        ) : null}
      </header>

      <div
        style={{
          position: 'relative',
          height: 148,
          background: 'var(--canvas-bg)',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        {node.isSkeleton ? (
          <div
            style={{
              width: '86%',
              height: '78%',
              borderRadius: 8,
              background:
                'linear-gradient(90deg, var(--canvas-skeleton), var(--canvas-skeleton-shine), var(--canvas-skeleton))',
              backgroundSize: '200% 100%',
              animation: 'canvas-shimmer 1.2s ease-in-out infinite',
            }}
          />
        ) : thumb ? (
          <img
            src={thumb}
            alt={node.label || node.variantId}
            draggable={false}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }}
          />
        ) : (
          <span className="canvas-muted">无预览</span>
        )}
      </div>

      {payload.upstreamChanged ? (
        <button
          type="button"
          className="canvas-btn"
          style={{
            width: '100%',
            borderRadius: 0,
            border: 'none',
            borderTop: '1px solid var(--canvas-border)',
            background: 'var(--canvas-warning-muted)',
            color: 'var(--canvas-warning)',
            height: 30,
            fontSize: 11,
          }}
          onClick={(e) => {
            e.stopPropagation()
            payload.onAction?.('rebind_baseline', node)
          }}
        >
          上游已变更，点此重新绑定基准
        </button>
      ) : null}

      {payload.showActions ? (
        <div
          className="canvas-node-actions"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
            padding: 8,
            borderTop: '1px solid var(--canvas-divider)',
            background: 'rgba(0,0,0,.18)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {primary.slice(0, 3).map((item) => (
            <button
              key={item.action}
              type="button"
              className="canvas-btn"
              disabled={!item.enabled}
              title={item.reason || item.label}
              style={{ height: 26, padding: '0 8px', fontSize: 11 }}
              onClick={() => payload.onAction?.(item.action, node)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      <Handle type="source" position={Position.Right} style={{ opacity: 0.35 }} />
    </div>
  )
}

export const canvasNodeTypes = {
  canvasCard: CanvasNodeCard,
}
