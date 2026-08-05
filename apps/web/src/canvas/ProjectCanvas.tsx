import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './theme.css'

import { apiFetch, approveWorkflowAsset, assetUrl } from '../api'
import { canvasNodeTypes, type CanvasNodeData } from './CanvasNodeCard'
import { listNodeActions, isEditableTarget, type ActionContext } from './canRunAction'
import {
  layoutGraphByStage,
  resolveFlowEdges,
  zoomPercent,
} from './layoutMath'
import type { CanvasGraph, CanvasGraphNode } from './types'

type ContextMenuState = {
  x: number
  y: number
  node: CanvasGraphNode
} | null

function ProjectCanvasInner({
  projectId,
  onOpenAssets,
}: {
  projectId: string
  onOpenAssets?: () => void
}) {
  const [graph, setGraph] = useState<CanvasGraph | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const [notice, setNotice] = useState('')
  const [downstreamByAsset, setDownstreamByAsset] = useState<Set<string>>(
    () => new Set(),
  )
  const { fitView, zoomIn, zoomOut } = useReactFlow()

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const loadGraph = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setError('')
    try {
      const response = await apiFetch(
        `/v1/projects/${encodeURIComponent(projectId)}/canvas-graph?includeOrphans=1`,
      )
      if (!response.ok) {
        throw new Error(`加载画布图谱失败：${response.status}`)
      }
      const body = (await response.json()) as CanvasGraph
      setGraph(body)

      const parentIds = new Set<string>()
      for (const edge of body.edges) {
        if (edge.sourceAssetId) parentIds.add(edge.sourceAssetId)
      }
      setDownstreamByAsset(parentIds)

      const laid = layoutGraphByStage(body.nodes)
      const flowEdges = resolveFlowEdges(body.nodes, body.edges)

      const flowNodes: Node[] = laid.map((item) => {
        const actionCtx: ActionContext = {
          hasDownstream: item.assetId
            ? parentIds.has(item.assetId)
            : false,
          isApprovedVariant: Boolean(item.approved),
        }
        const data: CanvasNodeData = {
          graphNode: item,
          actionCtx,
          showActions: selectedId === item.id,
          onAction: handleAction,
        }
        return {
          id: item.id,
          type: 'canvasCard',
          position: { x: item.x, y: item.y },
          data,
          style: { width: item.w },
        }
      })

      setNodes(flowNodes)
      setEdges(
        flowEdges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'default',
          animated: false,
          style: { stroke: 'rgba(255,255,255,0.22)', strokeWidth: 1.5 },
        })),
      )
      requestAnimationFrame(() => fitView({ padding: 0.18, duration: 200 }))
    } catch (value) {
      setError(value instanceof Error ? value.message : '加载失败')
    } finally {
      setLoading(false)
    }
    // handleAction is stable enough via setState; re-bind after load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, fitView, selectedId, setNodes, setEdges])

  const handleAction = useCallback(
    async (action: string, node: CanvasGraphNode) => {
      setContextMenu(null)
      setNotice('')
      try {
        if (action === 'open_full' && node.url) {
          window.open(assetUrl(node.url), '_blank', 'noopener,noreferrer')
          return
        }
        if (action === 'download' && node.url) {
          const a = document.createElement('a')
          a.href = assetUrl(node.url)
          a.download = `${node.variantId || 'image'}.png`
          a.target = '_blank'
          a.rel = 'noopener'
          a.click()
          return
        }
        if (
          (action === 'approve' || action === 'set_baseline') &&
          node.assetId &&
          node.variantId
        ) {
          const response = await approveWorkflowAsset(node.assetId, {
            variantId: node.variantId,
            comment: '画布节点批准',
          })
          if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as {
              detail?: string
            } | null
            if (response.status === 409) {
              setNotice(
                typeof payload?.detail === 'string'
                  ? payload.detail
                  : '上游已变更或已有下游，无法改批',
              )
              // 标记上游变更提示
              setNodes((current) =>
                current.map((item) =>
                  item.id === node.id
                    ? {
                        ...item,
                        data: {
                          ...(item.data as CanvasNodeData),
                          upstreamChanged: true,
                        },
                      }
                    : item,
                ),
              )
              return
            }
            throw new Error(
              typeof payload?.detail === 'string'
                ? payload.detail
                : `审批失败：${response.status}`,
            )
          }
          setNotice(`已批准 ${node.variantId}`)
          await loadGraph()
          return
        }
        if (
          action.startsWith('generate_') ||
          action === 'local_edit' ||
          action === 'reanalyze' ||
          action === 'view_structure'
        ) {
          setNotice('请在「AI 设计工作流」向导中继续该阶段生成（画布入口已记录）。')
          return
        }
        if (action === 'delete') {
          setNotice('删除仅软删画布节点（SceneAsset 保留）；完整删除 UI 将接 W0-d CRUD。')
          return
        }
        if (action === 'rebind_baseline') {
          setNotice('请重新批准当前节点作为下游基准。')
        }
      } catch (value) {
        setNotice(value instanceof Error ? value.message : '操作失败')
      }
    },
    [loadGraph, setNodes],
  )

  useEffect(() => {
    void loadGraph()
  }, [loadGraph])

  // 刷新选中态时同步浮动操作条
  useEffect(() => {
    setNodes((current) =>
      current.map((item) => ({
        ...item,
        data: {
          ...(item.data as CanvasNodeData),
          showActions: item.id === selectedId,
          onAction: handleAction,
          actionCtx: {
            hasDownstream: (item.data as CanvasNodeData).graphNode.assetId
              ? downstreamByAsset.has(
                  (item.data as CanvasNodeData).graphNode.assetId!,
                )
              : false,
            isApprovedVariant: Boolean(
              (item.data as CanvasNodeData).graphNode.approved,
            ),
          },
        },
      })),
    )
  }, [selectedId, handleAction, downstreamByAsset, setNodes])

  const onNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    setSelectedId(node.id)
    setContextMenu(null)
  }, [])

  const onNodeContextMenu: NodeMouseHandler = useCallback((event, node) => {
    event.preventDefault()
    const graphNode = (node.data as CanvasNodeData).graphNode
    setSelectedId(node.id)
    setContextMenu({ x: event.clientX, y: event.clientY, node: graphNode })
  }, [])

  const onPaneClick = useCallback(() => {
    setSelectedId(null)
    setContextMenu(null)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (!selectedId || !graph) return
      const node = graph.nodes.find((item) => item.id === selectedId)
      if (!node) return

      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        void handleAction('copy_node', node)
      } else if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        void handleAction('duplicate', node)
      } else if (meta && (event.key === 'Backspace' || event.key === 'Delete')) {
        event.preventDefault()
        void handleAction('delete', node)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        void handleAction('open_full', node)
      } else if (event.key === 'Escape') {
        setContextMenu(null)
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, graph, handleAction])

  const contextActions = useMemo(() => {
    if (!contextMenu) return []
    const ctx: ActionContext = {
      hasDownstream: contextMenu.node.assetId
        ? downstreamByAsset.has(contextMenu.node.assetId)
        : false,
      isApprovedVariant: Boolean(contextMenu.node.approved),
    }
    return listNodeActions(contextMenu.node, ctx)
  }, [contextMenu, downstreamByAsset])

  return (
    <div
      className="canvas-theme"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 560,
        borderRadius: 16,
        overflow: 'hidden',
        border: '1px solid var(--canvas-border)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          right: 12,
          zIndex: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          pointerEvents: 'none',
        }}
      >
        <div
          className="canvas-pill"
          style={{ pointerEvents: 'auto', height: 32, padding: '0 14px' }}
        >
          项目画布 · {projectId.slice(0, 10)}
          {graph?.includedOrphanAssets ? ' · 含无项目资产回退' : ''}
          {loading ? ' · 加载中…' : ` · ${graph?.nodeCount ?? 0} 节点`}
        </div>
        <div className="canvas-toolbar" style={{ pointerEvents: 'auto' }}>
          <button type="button" className="canvas-btn" onClick={() => zoomOut()}>
            −
          </button>
          <button
            type="button"
            className="canvas-btn"
            onClick={() => fitView({ padding: 0.18 })}
          >
            {zoomPercent(zoom)}%
          </button>
          <button type="button" className="canvas-btn" onClick={() => zoomIn()}>
            +
          </button>
          <button type="button" className="canvas-btn" onClick={() => void loadGraph()}>
            刷新
          </button>
        </div>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={canvasNodeTypes}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        onMove={(_, viewport) => setZoom(viewport.zoom)}
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'default' }}
        style={{ width: '100%', height: '100%' }}
      >
        <Background
          id="dots"
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.5}
          color="rgba(255,255,255,0.09)"
          bgColor="#0a0a0d"
        />
        <MiniMap
          pannable
          zoomable
          style={{
            background: '#12131a',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 12,
          }}
          maskColor="rgba(10,10,13,0.55)"
          nodeColor={() => 'rgba(255,255,255,0.22)'}
        />
        <Controls
          showInteractive={false}
          style={{
            borderRadius: 12,
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        />
      </ReactFlow>

      <div
        style={{
          position: 'absolute',
          left: 12,
          bottom: 12,
          zIndex: 6,
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <button
          type="button"
          className="canvas-btn"
          onClick={() => onOpenAssets?.()}
        >
          资产管理
        </button>
        <span className="canvas-pill">{zoomPercent(zoom)}%</span>
      </div>

      {error ? (
        <div
          className="canvas-card"
          style={{
            position: 'absolute',
            top: 64,
            left: 16,
            padding: 12,
            color: 'var(--canvas-danger)',
            zIndex: 7,
          }}
        >
          {error}
        </div>
      ) : null}

      {notice ? (
        <div
          className="canvas-card"
          style={{
            position: 'absolute',
            top: 64,
            right: 16,
            padding: '10px 14px',
            zIndex: 7,
            maxWidth: 320,
            fontSize: 13,
          }}
        >
          {notice}
        </div>
      ) : null}

      {!loading && graph && graph.nodeCount === 0 ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            pointerEvents: 'none',
            zIndex: 5,
          }}
        >
          <div className="canvas-card" style={{ padding: 24, textAlign: 'center' }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>画布为空</div>
            <div className="canvas-secondary" style={{ fontSize: 13 }}>
              在 AI 设计工作流中生成并批准方案后，谱系会显示在这里
            </div>
          </div>
        </div>
      ) : null}

      {contextMenu ? (
        <div
          className="canvas-card"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 50,
            minWidth: 200,
            padding: 6,
            boxShadow: 'var(--canvas-shadow)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextActions.map((item) => (
            <button
              key={item.action}
              type="button"
              disabled={!item.enabled}
              title={item.reason}
              onClick={() => void handleAction(item.action, contextMenu.node)}
              style={{
                display: 'flex',
                width: '100%',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                padding: '8px 10px',
                border: 'none',
                borderRadius: 8,
                background: 'transparent',
                color: item.enabled
                  ? 'var(--canvas-text)'
                  : 'var(--canvas-text-muted)',
                cursor: item.enabled ? 'pointer' : 'not-allowed',
                fontSize: 13,
              }}
            >
              <span>{item.label}</span>
              {item.shortcut ? (
                <span className="canvas-muted" style={{ fontSize: 11 }}>
                  {item.shortcut}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default function ProjectCanvas(props: {
  projectId: string
  onOpenAssets?: () => void
}) {
  return (
    <ReactFlowProvider>
      <ProjectCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
