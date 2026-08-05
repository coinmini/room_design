import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

import { apiFetch, assetUrl, type Job } from '../api'
import {
  executeCanvasAction,
  type StagePanelRequest,
} from '../workflow/canvasRunner'
import { canvasNodeTypes, type CanvasNodeData } from './CanvasNodeCard'
import CanvasStagePanel from './CanvasStagePanel'
import {
  listNodeActions,
  isEditableTarget,
  type ActionContext,
} from './canRunAction'
import {
  layoutGraphByStage,
  resolveFlowEdges,
  zoomPercent,
} from './layoutMath'
import type { CanvasGraph, CanvasGraphNode } from './types'

type ContextMenuState = {
  x: number
  y: number
  node: CanvasGraphNode | null
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
  const [busy, setBusy] = useState(false)
  const [designPrompt, setDesignPrompt] = useState('')
  const [panel, setPanel] = useState<StagePanelRequest | null>(null)
  const [panelNode, setPanelNode] = useState<CanvasGraphNode | null>(null)
  const [skeletonJobs, setSkeletonJobs] = useState<
    Array<{ jobId: string; label: string; parentId?: string }>
  >([])
  const [downstreamByAsset, setDownstreamByAsset] = useState<Set<string>>(
    () => new Set(),
  )
  const actionRef = useRef<(action: string, node: CanvasGraphNode | null) => void>(
    () => undefined,
  )
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const applyGraph = useCallback(
    (body: CanvasGraph, selected: string | null) => {
      setGraph(body)
      const parentIds = new Set<string>()
      for (const edge of body.edges) {
        if (edge.sourceAssetId) parentIds.add(edge.sourceAssetId)
      }
      setDownstreamByAsset(parentIds)

      const withSkeletons: CanvasGraphNode[] = [
        ...body.nodes,
        ...skeletonJobs.map((item) => ({
          id: `skeleton:${item.jobId}`,
          jobId: item.jobId,
          variantId: '_batch',
          label: item.label,
          title: item.label,
          isSkeleton: true,
          workflowStage: 'other',
          parentAssetId: item.parentId,
        })),
      ]

      const laid = layoutGraphByStage(withSkeletons)
      const flowEdges = resolveFlowEdges(body.nodes, body.edges)

      setNodes(
        laid.map((item) => {
          const actionCtx: ActionContext = {
            hasDownstream: item.assetId
              ? parentIds.has(item.assetId)
              : false,
            isApprovedVariant: Boolean(item.approved),
          }
          const data: CanvasNodeData = {
            graphNode: item,
            actionCtx,
            showActions: selected === item.id,
            onAction: (action: string, node: CanvasGraphNode) =>
              actionRef.current(action, node),
          }
          return {
            id: item.id,
            type: 'canvasCard',
            position: { x: item.x, y: item.y },
            data,
            style: { width: item.w },
          }
        }),
      )
      setEdges(
        flowEdges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'default',
          style: { stroke: 'rgba(255,255,255,0.22)', strokeWidth: 1.5 },
        })),
      )
    },
    [setNodes, setEdges, skeletonJobs],
  )

  const loadGraph = useCallback(
    async (opts?: { fit?: boolean }) => {
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
        applyGraph(body, selectedId)
        if (opts?.fit !== false) {
          requestAnimationFrame(() => fitView({ padding: 0.18, duration: 200 }))
        }
      } catch (value) {
        setError(value instanceof Error ? value.message : '加载失败')
      } finally {
        setLoading(false)
      }
    },
    [projectId, applyGraph, selectedId, fitView],
  )

  useEffect(() => {
    void loadGraph()
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 选中态刷新操作条
  useEffect(() => {
    setNodes((current) =>
      current.map((item) => ({
        ...item,
        data: {
          ...(item.data as CanvasNodeData),
          showActions: item.id === selectedId,
          onAction: (action: string, node: CanvasGraphNode) =>
            actionRef.current(action, node),
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
  }, [selectedId, downstreamByAsset, setNodes])

  const trackJob = useCallback((job: Job, label: string, parentId?: string) => {
    if (['QUEUED', 'RUNNING'].includes(job.status)) {
      setSkeletonJobs((current) => {
        if (current.some((item) => item.jobId === job.id)) return current
        return [...current, { jobId: job.id, label, parentId }]
      })
    }
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(job.status)) {
      setSkeletonJobs((current) =>
        current.filter((item) => item.jobId !== job.id),
      )
    }
  }, [])

  const runAction = useCallback(
    async (
      action: string,
      node: CanvasGraphNode | null,
      extras?: Parameters<typeof executeCanvasAction>[0]['extras'],
    ) => {
      setContextMenu(null)
      setNotice('')
      setBusy(true)
      try {
        if (action === 'open_full' && node?.url) {
          window.open(assetUrl(node.url), '_blank', 'noopener,noreferrer')
          return
        }
        if (action === 'download' && node?.url) {
          const a = document.createElement('a')
          a.href = assetUrl(node.url)
          a.download = `${node.variantId || 'image'}.png`
          a.target = '_blank'
          a.click()
          return
        }

        const result = await executeCanvasAction({
          projectId,
          node,
          action,
          extras: {
            designPrompt,
            ...extras,
          },
          onJob: (job) =>
            trackJob(
              job,
              actionLabel(action),
              node?.assetId || undefined,
            ),
          onNeedPanel: (next) => {
            setPanel(next)
            setPanelNode(node)
          },
        })

        if (!result.ok) {
          setPanel(result.needPanel)
          setPanelNode(node)
          return
        }

        if (result.message === 'view_structure' && node?.url) {
          window.open(assetUrl(node.url), '_blank', 'noopener,noreferrer')
          setNotice('已在新窗口打开结构图（完整结构编辑器可后续全屏接入）')
          return
        }

        setNotice(result.message)
        setPanel(null)
        setPanelNode(null)
        await loadGraph({ fit: false })
      } catch (value) {
        const message = value instanceof Error ? value.message : '操作失败'
        setNotice(message)
        if (message.includes('下游') || message.includes('版本')) {
          // 409 类：标记重绑定
          if (node) {
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
          }
        }
      } finally {
        setBusy(false)
      }
    },
    [projectId, designPrompt, trackJob, loadGraph, setNodes],
  )

  actionRef.current = (action, node) => {
    void runAction(action, node)
  }

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

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault()
      setContextMenu({ x: event.clientX, y: event.clientY, node: null })
    },
    [],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (!selectedId || !graph) return
      const node = graph.nodes.find((item) => item.id === selectedId)
      if (!node) return
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === 'c') {
        event.preventDefault()
        void runAction('copy_node', node)
      } else if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        void runAction('duplicate', node)
      } else if (meta && (event.key === 'Backspace' || event.key === 'Delete')) {
        event.preventDefault()
        void runAction('delete', node)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        void runAction('open_full', node)
      } else if (event.key === 'Escape') {
        setContextMenu(null)
        setPanel(null)
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, graph, runAction])

  const contextActions = useMemo(() => {
    if (!contextMenu) return []
    if (!contextMenu.node) {
      return [
        {
          action: 'upload_floorplan' as const,
          enabled: true,
          label: '上传户型图（01）',
        },
      ]
    }
    const ctx: ActionContext = {
      hasDownstream: contextMenu.node.assetId
        ? downstreamByAsset.has(contextMenu.node.assetId)
        : false,
      isApprovedVariant: Boolean(contextMenu.node.approved),
    }
    return listNodeActions(contextMenu.node, ctx)
  }, [contextMenu, downstreamByAsset])

  const selectedNode = graph?.nodes.find((n) => n.id === selectedId) ?? null

  return (
    <div
      className="canvas-theme canvas-shell"
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
      {/* 顶栏胶囊 */}
      <div className="canvas-topbar">
        <div className="canvas-toolbar">
          <span className="canvas-pill">项目 · {projectId.slice(0, 10)}</span>
          <span className="canvas-pill">
            {loading ? '同步中…' : `${graph?.nodeCount ?? 0} 节点`}
          </span>
          {graph?.includedOrphanAssets ? (
            <span className="canvas-pill">含无项目资产</span>
          ) : null}
        </div>
        <div className="canvas-toolbar">
          <input
            className="canvas-prompt-inline"
            value={designPrompt}
            onChange={(e) => setDesignPrompt(e.target.value)}
            placeholder="设计意向（生成时携带）"
          />
          <button
            type="button"
            className="canvas-btn canvas-btn-primary"
            disabled={busy}
            onClick={() => void runAction('upload_floorplan', null)}
          >
            + 户型
          </button>
          <button
            type="button"
            className="canvas-btn"
            onClick={() => void loadGraph()}
            disabled={busy}
          >
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
        onPaneContextMenu={onPaneContextMenu}
        onMove={(_, viewport) => setZoom(viewport.zoom)}
        minZoom={0.15}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        style={{ width: '100%', height: '100%' }}
      >
        <Background
          id="dots"
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.4}
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
        <Controls showInteractive={false} />
      </ReactFlow>

      {/* 底栏胶囊 */}
      <div className="canvas-bottombar">
        <div className="canvas-toolbar">
          <button
            type="button"
            className="canvas-btn"
            onClick={() => onOpenAssets?.()}
          >
            资产管理
          </button>
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
          {selectedNode ? (
            <span className="canvas-pill">
              已选 {(selectedNode.label || selectedNode.variantId || '').replaceAll('_', ' ')}
            </span>
          ) : (
            <span className="canvas-pill canvas-muted-pill">右键空白处上传户型</span>
          )}
          {busy ? <span className="canvas-pill">执行中…</span> : null}
        </div>
      </div>

      {error ? (
        <div className="canvas-toast canvas-toast-error">{error}</div>
      ) : null}
      {notice ? <div className="canvas-toast">{notice}</div> : null}

      {!loading && graph && graph.nodeCount === 0 && !skeletonJobs.length ? (
        <div className="canvas-empty">
          <div className="canvas-card" style={{ padding: 28, textAlign: 'center' }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>从户型开始</div>
            <div className="canvas-secondary" style={{ fontSize: 13, marginBottom: 16 }}>
              上传户型图完成 01 识别，再沿节点批准并生成 02→08
            </div>
            <button
              type="button"
              className="canvas-btn canvas-btn-primary"
              onClick={() => void runAction('upload_floorplan', null)}
            >
              上传户型图
            </button>
          </div>
        </div>
      ) : null}

      {contextMenu ? (
        <div
          className="canvas-card canvas-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextActions.map((item) => (
            <button
              key={item.action}
              type="button"
              disabled={'enabled' in item ? !item.enabled : false}
              title={'reason' in item ? item.reason : undefined}
              onClick={() =>
                void runAction(item.action, contextMenu.node)
              }
              className="canvas-context-item"
            >
              <span>{item.label}</span>
              {'shortcut' in item && item.shortcut ? (
                <span className="canvas-muted">{item.shortcut}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {panel ? (
        <CanvasStagePanel
          panel={panel}
          busy={busy}
          designPrompt={designPrompt}
          onDesignPromptChange={setDesignPrompt}
          onCancel={() => {
            if (!busy) {
              setPanel(null)
              setPanelNode(null)
            }
          }}
          onSubmitUpload={(file, planWidthMm, planDepthMm) => {
            void runAction('upload_floorplan_submit', panelNode, {
              file,
              planWidthMm,
              planDepthMm,
            })
          }}
          onSubmitSpaces={(spaceIds) => {
            void runAction('generate_space_render', panelNode, {
              selectedSpaceIds: spaceIds,
            })
          }}
          onSubmitLocalEdit={(markFile, editPrompt) => {
            void runAction('local_edit', panelNode, { markFile, editPrompt })
          }}
        />
      ) : null}
    </div>
  )
}

function actionLabel(action: string): string {
  const map: Record<string, string> = {
    upload_floorplan_submit: '01 户型识别',
    reanalyze: '01 重新识别',
    generate_layout: '02 布局',
    generate_color_plan: '03 彩平',
    generate_axonometric: '04 轴侧',
    generate_space_render: '05 分空间',
    generate_style_scheme: '06 风格',
    generate_tone_scheme: '07 色调',
    local_edit: '08 局部修改',
  }
  return map[action] || action
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
