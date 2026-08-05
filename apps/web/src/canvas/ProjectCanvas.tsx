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
import FloorplanModule, {
  type FloorplanStage01Approval,
} from '../FloorplanModule'
import {
  executeCanvasAction,
  type Stage01ApprovalPayload,
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
import { normalizeStage } from './types'

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
  /** jobId → 01 结构确认（生成布局门禁） */
  const [stage01ByJob, setStage01ByJob] = useState<
    Record<string, FloorplanStage01Approval>
  >({})
  const [structureEditor, setStructureEditor] = useState<{
    jobId: string
    node: CanvasGraphNode
  } | null>(null)
  const actionRef = useRef<(action: string, node: CanvasGraphNode | null) => void>(
    () => undefined,
  )
  const stage01ByJobRef = useRef(stage01ByJob)
  stage01ByJobRef.current = stage01ByJob
  const structureEditorRef = useRef(structureEditor)
  structureEditorRef.current = structureEditor
  const { fitView, zoomIn, zoomOut, setCenter, getNode } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const inStructureFocus = Boolean(structureEditor)

  const exitStructureFocus = useCallback(
    (opts?: { focusNodeId?: string; notice?: string }) => {
      const focusNodeId =
        opts?.focusNodeId ?? structureEditorRef.current?.node.id
      setStructureEditor(null)
      if (opts?.notice) setNotice(opts.notice)
      requestAnimationFrame(() => {
        if (focusNodeId) {
          const n = getNode(focusNodeId)
          if (n) {
            setCenter(n.position.x + 110, n.position.y + 120, {
              zoom: 1,
              duration: 280,
            })
            setSelectedId(focusNodeId)
            return
          }
        }
        fitView({ padding: 0.18, duration: 280 })
      })
    },
    [fitView, getNode, setCenter],
  )

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
      const confirmedJobs = stage01ByJobRef.current

      setNodes(
        laid.map((item) => {
          const stage = normalizeStage(item)
          const actionCtx: ActionContext = {
            hasDownstream: item.assetId
              ? parentIds.has(item.assetId)
              : false,
            isApprovedVariant: Boolean(item.approved),
            stage01Confirmed:
              stage === 'floorplan' && item.jobId
                ? Boolean(confirmedJobs[item.jobId])
                : undefined,
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

  // 选中态 / 01 确认态刷新操作条
  useEffect(() => {
    setNodes((current) =>
      current.map((item) => {
        const graphNode = (item.data as CanvasNodeData).graphNode
        const stage = normalizeStage(graphNode)
        return {
          ...item,
          data: {
            ...(item.data as CanvasNodeData),
            showActions: item.id === selectedId,
            onAction: (action: string, node: CanvasGraphNode) =>
              actionRef.current(action, node),
            actionCtx: {
              hasDownstream: graphNode.assetId
                ? downstreamByAsset.has(graphNode.assetId)
                : false,
              isApprovedVariant: Boolean(graphNode.approved),
              stage01Confirmed:
                stage === 'floorplan' && graphNode.jobId
                  ? Boolean(stage01ByJob[graphNode.jobId])
                  : undefined,
            },
          },
        }
      }),
    )
  }, [selectedId, downstreamByAsset, stage01ByJob, setNodes])

  const openStructureEditor = useCallback((node: CanvasGraphNode) => {
    if (!node.jobId) {
      setNotice('该节点缺少分析任务 ID，无法打开结构编辑器')
      return
    }
    if (normalizeStage(node) !== 'floorplan' && node.moduleKey !== 'floorplan') {
      // 仍允许带 job 的 floorplan 分析节点
      if (!node.jobId.startsWith('job_') && !node.assetType?.includes('floorplan')) {
        setNotice('仅户型识别节点可打开结构编辑器')
        return
      }
    }
    setContextMenu(null)
    setStructureEditor({ jobId: node.jobId, node })
  }, [])

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

        // 01 结构：打开全屏 FloorplanModule（图1），不再只打开静态 overlay
        if (
          (action === 'view_structure' || action === 'edit_structure') &&
          node
        ) {
          openStructureEditor(node)
          return
        }

        if (action === 'generate_layout' && node?.jobId) {
          const approval = stage01ByJobRef.current[node.jobId]
          if (!approval) {
            setNotice('请先双击节点，在结构编辑器中确认结构后再生成布局')
            openStructureEditor(node)
            return
          }
          extras = {
            ...extras,
            stage01Approval: toStage01Payload(approval),
          }
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

        setNotice(result.message)
        setPanel(null)
        setPanelNode(null)
        await loadGraph({ fit: false })

        // 01 识别成功后自动打开结构编辑器（图1）
        if (
          (action === 'upload_floorplan_submit' || action === 'reanalyze') &&
          result.job?.id &&
          result.job.type === 'FLOORPLAN_ANALYZE' &&
          result.job.status === 'SUCCEEDED'
        ) {
          setStructureEditor({
            jobId: result.job.id,
            node: {
              id: `pending:${result.job.id}`,
              jobId: result.job.id,
              variantId: 'analysis',
              moduleKey: 'floorplan',
              workflowStage: 'floorplan',
            },
          })
          setNotice('识别完成：请在结构编辑器中核对房间参数并确认')
        }
      } catch (value) {
        const message = value instanceof Error ? value.message : '操作失败'
        setNotice(message)
        if (
          message.includes('结构编辑器') ||
          message.includes('确认结构')
        ) {
          if (node) openStructureEditor(node)
        }
        if (message.includes('下游') || message.includes('版本')) {
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
    [
      projectId,
      designPrompt,
      trackJob,
      loadGraph,
      setNodes,
      openStructureEditor,
    ],
  )

  actionRef.current = (action, node) => {
    void runAction(action, node)
  }

  const onNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    setSelectedId(node.id)
    setContextMenu(null)
  }, [])

  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const graphNode = (node.data as CanvasNodeData).graphNode
      setSelectedId(node.id)
      const stage = normalizeStage(graphNode)
      if (
        stage === 'floorplan' ||
        graphNode.moduleKey === 'floorplan' ||
        graphNode.assetType?.includes('floorplan')
      ) {
        openStructureEditor(graphNode)
      }
    },
    [openStructureEditor],
  )

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
      if (event.key === 'Escape') {
        event.preventDefault()
        if (structureEditorRef.current) {
          exitStructureFocus({
            notice: stage01ByJobRef.current[structureEditorRef.current.jobId]
              ? undefined
              : '已返回图谱（结构尚未确认，生成布局前请先确认）',
          })
          return
        }
        setContextMenu(null)
        setPanel(null)
        setSelectedId(null)
        return
      }
      if (structureEditorRef.current) return
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, graph, runAction, exitStructureFocus])

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
    const stage = normalizeStage(contextMenu.node)
    const ctx: ActionContext = {
      hasDownstream: contextMenu.node.assetId
        ? downstreamByAsset.has(contextMenu.node.assetId)
        : false,
      isApprovedVariant: Boolean(contextMenu.node.approved),
      stage01Confirmed:
        stage === 'floorplan' && contextMenu.node.jobId
          ? Boolean(stage01ByJob[contextMenu.node.jobId])
          : undefined,
    }
    return listNodeActions(contextMenu.node, ctx)
  }, [contextMenu, downstreamByAsset, stage01ByJob])

  const selectedNode = graph?.nodes.find((n) => n.id === selectedId) ?? null
  const focusConfirmed = structureEditor
    ? Boolean(stage01ByJob[structureEditor.jobId])
    : false

  return (
    <div
      className={`canvas-theme canvas-shell${inStructureFocus ? ' is-structure-focus' : ''}`}
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
      {/* 顶栏：图谱 / 结构 focus 共用，保持项目语境 */}
      <div className="canvas-topbar">
        <div className="canvas-toolbar">
          {inStructureFocus ? (
            <>
              <button
                type="button"
                className="canvas-btn"
                onClick={() =>
                  exitStructureFocus({
                    notice: focusConfirmed
                      ? undefined
                      : '已返回图谱（结构尚未确认）',
                  })
                }
              >
                ← 返回图谱
              </button>
              <span className="canvas-pill">01 结构确认</span>
              <span className="canvas-pill">
                {structureEditor?.node.title ||
                  structureEditor?.node.label ||
                  '户型分析'}
              </span>
              {focusConfirmed ? (
                <span className="canvas-pill" style={{ color: 'var(--canvas-success)' }}>
                  ✓ 已确认
                </span>
              ) : (
                <span className="canvas-pill canvas-muted-pill">编辑中</span>
              )}
            </>
          ) : (
            <>
              <span className="canvas-pill">项目 · {projectId.slice(0, 10)}</span>
              <span className="canvas-pill">
                {loading ? '同步中…' : `${graph?.nodeCount ?? 0} 节点`}
              </span>
              {graph?.includedOrphanAssets ? (
                <span className="canvas-pill">含无项目资产</span>
              ) : null}
            </>
          )}
        </div>
        {!inStructureFocus ? (
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
        ) : (
          <div className="canvas-toolbar">
            <span className="canvas-pill canvas-muted-pill">
              同一项目画布 · 不离开本页
            </span>
            <button
              type="button"
              className="canvas-btn canvas-btn-primary"
              onClick={() =>
                exitStructureFocus({
                  notice: focusConfirmed
                    ? '已返回图谱'
                    : '已返回图谱（结构尚未确认）',
                })
              }
            >
              完成并返回
            </button>
          </div>
        )}
      </div>

      <div className="canvas-body">
        {/* 图谱常驻挂载，focus 时仅隐藏，保留视口 */}
        <div
          className={`canvas-graph-pane${inStructureFocus ? ' is-parked' : ''}`}
          aria-hidden={inStructureFocus}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={canvasNodeTypes}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
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
                  已选{' '}
                  {(selectedNode.label || selectedNode.variantId || '').replaceAll(
                    '_',
                    ' ',
                  )}
                </span>
              ) : (
                <span className="canvas-pill canvas-muted-pill">
                  右键空白处上传户型 · 双击 01 编辑结构
                </span>
              )}
              {busy ? <span className="canvas-pill">执行中…</span> : null}
            </div>
          </div>

          {!loading && graph && graph.nodeCount === 0 && !skeletonJobs.length ? (
            <div className="canvas-empty">
              <div className="canvas-card" style={{ padding: 28, textAlign: 'center' }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>从户型开始</div>
                <div
                  className="canvas-secondary"
                  style={{ fontSize: 13, marginBottom: 16 }}
                >
                  上传户型图完成 01 识别，在画布内确认结构后再生成 02→08
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
        </div>

        {/* 01 结构专注坞：深色壳 + 亮色绘图区，不跳路由 */}
        {structureEditor ? (
          <div className="canvas-structure-dock">
            <aside className="canvas-structure-rail">
              <div className="canvas-structure-rail-title">画布上下文</div>
              <div className="canvas-pill" style={{ width: '100%', justifyContent: 'center' }}>
                阶段 01
              </div>
              <p className="canvas-secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
                正在编辑节点结构，确认后返回同一图谱继续生成布局。
              </p>
              {structureEditor.node.url || structureEditor.node.thumbnailUrl ? (
                <img
                  className="canvas-structure-thumb"
                  src={assetUrl(
                    structureEditor.node.thumbnailUrl ||
                      structureEditor.node.url ||
                      undefined,
                  )}
                  alt=""
                />
              ) : null}
              <button
                type="button"
                className="canvas-btn"
                style={{ width: '100%' }}
                onClick={() =>
                  exitStructureFocus({
                    notice: focusConfirmed
                      ? undefined
                      : '已返回图谱（结构尚未确认）',
                  })
                }
              >
                ← 返回图谱
              </button>
              <p className="canvas-muted" style={{ fontSize: 11 }}>
                Esc 也可返回
              </p>
            </aside>
            <div className="canvas-structure-main">
              <FloorplanModule
                key={structureEditor.jobId}
                presentation="canvas-focus"
                resumeAnalysisJobId={structureEditor.jobId}
                onRequestClose={() =>
                  exitStructureFocus({
                    notice: focusConfirmed
                      ? undefined
                      : '已返回图谱（结构尚未确认）',
                  })
                }
                onApproved={(approval) => {
                  setStage01ByJob((current) => ({
                    ...current,
                    [approval.analysisJobId]: approval,
                  }))
                  exitStructureFocus({
                    focusNodeId: structureEditor.node.id,
                    notice:
                      '结构已确认。可在该户型节点上点击「生成布局」进入 02。',
                  })
                }}
                onApprovalInvalidated={() => {
                  if (structureEditor.jobId) {
                    setStage01ByJob((current) => {
                      const next = { ...current }
                      delete next[structureEditor.jobId]
                      return next
                    })
                  }
                }}
              />
            </div>
          </div>
        ) : null}
      </div>

      {error && !inStructureFocus ? (
        <div className="canvas-toast canvas-toast-error">{error}</div>
      ) : null}
      {notice ? <div className="canvas-toast">{notice}</div> : null}

      {!inStructureFocus && contextMenu ? (
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
              onClick={() => void runAction(item.action, contextMenu.node)}
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

function toStage01Payload(
  approval: FloorplanStage01Approval,
): Stage01ApprovalPayload {
  return {
    approvedLayoutImage: approval.approvedLayoutImage,
    semanticLayout: approval.semanticLayout as unknown as Record<string, unknown>,
    planWidthMm: approval.planWidthMm,
    planDepthMm: approval.planDepthMm,
    analysisJobId: approval.analysisJobId,
    approvedLayoutVersionId: approval.approvedLayoutVersionId,
    sourceSha256: approval.sourceSha256,
    detectedBounds: approval.detectedBounds,
  }
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
