import type { CSSProperties } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { assetUrl } from '../api'
import type { CanvasGraphNode } from './types'
import { isVariantApproved, stageLabel, normalizeStage } from './types'
import { listNodeActions, type ActionContext } from './canRunAction'
import { canSpawnFromNode, spawnHandleTitle } from './spawnDerive'

export type CanvasNodeData = {
  graphNode: CanvasGraphNode
  selected?: boolean
  actionCtx?: ActionContext
  onAction?: (action: string, node: CanvasGraphNode) => void
  showActions?: boolean
  upstreamChanged?: boolean
  /** 展开多图堆叠 */
  onExpandStack?: (stackKey: string) => void
  /** 收起多图堆叠 */
  onCollapseStack?: (stackKey: string) => void
}

export function CanvasNodeCard({ data, selected }: NodeProps) {
  const payload = data as unknown as CanvasNodeData
  const node = payload.graphNode
  const stage = normalizeStage(node)
  const thumb = assetUrl(node.thumbnailUrl || node.url || undefined)
  const isStack = Boolean(node.isStack)
  const stackCount = node.stackCount ?? node.stackItems?.length ?? 0
  const stackPreviews = (node.stackItems ?? [])
    .slice(0, 3)
    .map((item) => assetUrl(item.thumbnailUrl || item.url || undefined))
    .filter(Boolean) as string[]

  const actions = listNodeActions(node, payload.actionCtx ?? {})
  const primary = actions.filter(
    (a) =>
      [
        'view_structure',
        'generate_layout',
        'approve',
        'unapprove',
        'set_baseline',
        'generate_style_scheme',
        'generate_tone_scheme',
        'local_edit',
        'generate_color_plan',
        'generate_space_render',
        'generate_axonometric',
        'open_full',
        'retry',
        'delete',
      ].includes(a.action),
  )
  const skeletonFailed =
    node.isSkeleton &&
    (node.jobStatus === 'FAILED' || node.jobStatus === 'CANCELED')
  const showFooter =
    payload.showActions || skeletonFailed

  // 01–07：满足前置条件时可拖出拖把线派生下一阶段
  const canSpawn = canSpawnFromNode(node, {
    stage01Confirmed: payload.actionCtx?.stage01Confirmed,
  })
  const spawnTitle = spawnHandleTitle(node, {
    stage01Confirmed: payload.actionCtx?.stage01Confirmed,
  })

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
    // 勿 hidden：会裁掉外侧把手，导致拖出难触发
    overflow: 'visible',
    color: 'var(--canvas-text)',
    fontSize: 12,
    position: 'relative',
  }

  return (
    <div
      className={`canvas-node-card${isStack ? ' is-stack' : ''}${
        node.stackExpanded ? ' is-stack-member' : ''
      }`}
      style={cardStyle}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="canvas-handle canvas-handle-target"
        /* 12px 把手 + CSS left:-6px → 中心在方框左边缘 */
        style={{ width: 12, height: 12 }}
      />
      <div className="canvas-node-card-inner">
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '8px 10px',
          borderBottom: '1px solid var(--canvas-divider)',
          background: 'var(--canvas-bg-elevated)',
          borderRadius: '12px 12px 0 0',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            className="canvas-secondary"
            style={{ fontSize: 10, letterSpacing: '0.04em' }}
          >
            {stageLabel(stage)}
            {isStack ? ' · 堆叠' : ''}
            {node.stackExpanded && stackCount > 1
              ? ` · ${ (node.stackIndex ?? 0) + 1 }/${stackCount}`
              : ''}
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
        {isStack ? (
          <span
            className="canvas-pill"
            style={{
              background: 'var(--canvas-primary-muted)',
              borderColor: 'transparent',
              color: 'var(--canvas-primary)',
              height: 22,
              padding: '0 8px',
              fontWeight: 700,
            }}
            title={`${stackCount} 张图片 · 点击全屏一览`}
          >
            {stackCount}
          </span>
        ) : node.stackExpanded && node.stackKey ? (
          <button
            type="button"
            className="canvas-pill canvas-stack-collapse-chip nodrag nopan"
            title="收起为堆叠"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              payload.onCollapseStack?.(node.stackKey!)
            }}
          >
            收起
          </button>
        ) : payload.actionCtx?.stage01Confirmed ? (
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
        ) : isVariantApproved(node) ? (
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
            style={{
              height: 22,
              padding: '0 8px',
              ...(node.jobStatus === 'FAILED'
                ? {
                    background: 'var(--canvas-danger-muted)',
                    borderColor: 'transparent',
                    color: 'var(--canvas-danger)',
                  }
                : node.jobStatus === 'CANCELED'
                  ? {
                      background: 'var(--canvas-warning-muted)',
                      borderColor: 'transparent',
                      color: 'var(--canvas-warning)',
                    }
                  : {}),
            }}
            title={node.errorMessage || undefined}
          >
            {node.jobStatus === 'FAILED'
              ? '失败'
              : node.jobStatus === 'CANCELED'
                ? '已取消'
                : node.progressSucceeded != null && node.progressTotal
                  ? `${node.progressSucceeded}/${node.progressTotal}`
                  : '生成中'}
          </span>
        ) : null}
      </header>

      <div
        className="canvas-node-thumb"
        style={{
          position: 'relative',
          height: 148,
          background: 'var(--canvas-bg)',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        {isStack ? (
          <div className="canvas-stack-layers">
            {/* 背后层叠卡片 */}
            {[2, 1].map((depth) => (
              <div
                key={depth}
                className="canvas-stack-layer"
                style={{
                  transform: `translate(${depth * 5}px, ${depth * 5}px) scale(${
                    1 - depth * 0.04
                  })`,
                  zIndex: 3 - depth,
                  opacity: 0.55 - depth * 0.1,
                }}
              >
                {stackPreviews[depth] ? (
                  <img
                    src={stackPreviews[depth]}
                    alt=""
                    draggable={false}
                    loading="lazy"
                    decoding="async"
                    width={220}
                    height={148}
                  />
                ) : (
                  <div className="canvas-stack-placeholder" />
                )}
              </div>
            ))}
            <div className="canvas-stack-layer is-front" style={{ zIndex: 4 }}>
              {stackPreviews[0] || thumb ? (
                <img
                  src={stackPreviews[0] || thumb}
                  alt={node.label || 'stack'}
                  draggable={false}
                  loading="lazy"
                  decoding="async"
                  width={220}
                  height={148}
                />
              ) : (
                <span className="canvas-muted">无预览</span>
              )}
              <div className="canvas-stack-hint">
                点击全屏一览 {stackCount} 张
              </div>
            </div>
          </div>
        ) : node.isSkeleton && thumb ? (
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <img
              src={thumb}
              alt={node.label || 'partial'}
              draggable={false}
              loading="lazy"
              decoding="async"
              width={220}
              height={148}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                opacity: node.jobStatus === 'FAILED' ? 0.55 : 0.92,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: 8,
                bottom: 8,
                padding: '2px 8px',
                borderRadius: 999,
                fontSize: 10,
                background: 'rgba(0,0,0,0.55)',
                color: '#fff',
              }}
            >
              {node.jobStatus === 'FAILED'
                ? '失败 · 可重试'
                : node.jobStatus === 'CANCELED'
                  ? '已取消'
                  : '部分已出图'}
            </div>
          </div>
        ) : node.isSkeleton ? (
          <div
            style={{
              width: '86%',
              height: '78%',
              borderRadius: 8,
              border:
                node.jobStatus === 'FAILED'
                  ? '1px dashed rgba(239,68,68,0.55)'
                  : '1px dashed rgba(59,130,246,0.45)',
              background:
                node.jobStatus === 'FAILED'
                  ? 'rgba(239,68,68,0.08)'
                  : 'linear-gradient(90deg, var(--canvas-skeleton), var(--canvas-skeleton-shine), var(--canvas-skeleton))',
              backgroundSize: '200% 100%',
              animation:
                node.jobStatus === 'FAILED' || node.jobStatus === 'CANCELED'
                  ? undefined
                  : 'canvas-shimmer 1.2s ease-in-out infinite',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--canvas-text-muted)',
              fontSize: 11,
              gap: 6,
              padding: 8,
              textAlign: 'center',
            }}
          >
            {node.jobStatus === 'FAILED' ? (
              <>
                <span style={{ color: 'var(--canvas-danger)', opacity: 0.9 }}>
                  生成失败
                </span>
                <span style={{ fontSize: 10, opacity: 0.65 }}>
                  {node.errorMessage?.slice(0, 48) || '请重试或检查上游'}
                </span>
              </>
            ) : node.jobStatus === 'CANCELED' ? (
              <span style={{ opacity: 0.85 }}>已取消</span>
            ) : (
              <>
                <span style={{ opacity: 0.85 }}>
                  {node.progressSucceeded != null && node.progressTotal
                    ? `生成中 ${node.progressSucceeded}/${node.progressTotal}`
                    : '生成中…'}
                </span>
                <span style={{ fontSize: 10, opacity: 0.55 }}>请稍候</span>
              </>
            )}
          </div>
        ) : thumb ? (
          <img
            src={thumb}
            alt={node.label || node.variantId}
            draggable={false}
            loading="lazy"
            decoding="async"
            width={220}
            height={148}
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

      {node.stackExpanded && node.stackKey ? (
        <button
          type="button"
          className="canvas-btn canvas-stack-collapse-bar nodrag nopan"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            payload.onCollapseStack?.(node.stackKey!)
          }}
        >
          ↑ 收起堆叠（{stackCount} 张）
        </button>
      ) : null}

      {showFooter && !isStack ? (
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
              style={{
                height: 26,
                padding: '0 8px',
                fontSize: 11,
                ...(item.action === 'retry'
                  ? {
                      background: 'var(--canvas-primary-muted)',
                      color: 'var(--canvas-primary)',
                      borderColor: 'transparent',
                    }
                  : item.action === 'delete' && skeletonFailed
                    ? {
                        background: 'var(--canvas-danger-muted)',
                        color: 'var(--canvas-danger)',
                        borderColor: 'transparent',
                      }
                    : {}),
              }}
              onClick={() => payload.onAction?.(item.action, node)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      </div>
      <Handle
        type="source"
        position={Position.Right}
        className={`canvas-handle canvas-handle-source${
          canSpawn ? ' canvas-handle-spawn' : ''
        }`}
        /* 12/18px + CSS right:-半宽 → 中心在方框右边缘，边不会飘在缝里 */
        style={{
          width: canSpawn ? 18 : 12,
          height: canSpawn ? 18 : 12,
        }}
        title={spawnTitle}
      />
    </div>
  )
}

export const canvasNodeTypes = {
  canvasCard: CanvasNodeCard,
}
