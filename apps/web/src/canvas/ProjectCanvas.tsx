import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import CanvasChrome from './CanvasChrome'
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
  type Connection,
  type NodeMouseHandler,
  type OnConnectEnd,
  type OnConnectStart,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './theme.css'

import { apiFetch, assetUrl } from '../api'
import FloorplanModule, {
  type FloorplanStage01Approval,
} from '../FloorplanModule'
import { type StagePanelRequest } from '../workflow/canvasRunner'
import { canvasEdgeTypes } from './BorderEdge'
import { canvasNodeTypes, type CanvasNodeData } from './CanvasNodeCard'
import CanvasStagePanel from './CanvasStagePanel'
import GenerateLayoutDialog, {
  composeLayoutDesignPrompt,
  type GenerateDialogMode,
} from './GenerateLayoutDialog'
import {
  actionForDialogMode,
  dialogModeForAction,
  isSpawnDialogAction,
  nodeHasApprovedSpawnSource,
  primarySpawnForNode,
  resolveSpawnSourceNode,
  spawnOptionsForNode,
} from './spawnDerive'
import SpawnMenu, { type SpawnMenuState } from './SpawnMenu'
import { useCanvasSkeletons } from './useCanvasSkeletons'
import { useResumeActiveJobs } from './useResumeActiveJobs'
import { useCanvasRunAction } from './useCanvasRunAction'
import { buildCanvasFlow } from './buildCanvasFlow'
import { isStage01Node, isStageImageDetailNode } from './nodeStage'
import { clampMenuPosition } from './menuMath'
import LayoutDetailDock from './LayoutDetailDock'
import LocalEditDock, { type LocalEditSession } from './LocalEditDock'
import StackGallery, { type StackGalleryState } from './StackGallery'
import { approveVariantIdempotent } from '../workflow/actions'
import {
  listNodeActions,
  isEditableTarget,
  type ActionContext,
} from './canRunAction'
import { zoomPercent } from './layoutMath'
import {
  canOpenStageDetail,
  primaryDeriveActionsForStage,
} from './stageDetail'
import type { CanvasGraph, CanvasGraphNode } from './types'
import { isVariantApproved, normalizeStage, stageLabel } from './types'

type ContextMenuState = {
  x: number
  y: number
  node: CanvasGraphNode | null
} | null

function ProjectCanvasInner({
  projectId,
  onOpenAssets,
  showAppChrome,
}: {
  projectId: string
  onOpenAssets?: () => void
  /** 画布页：把首页/向导并入单行顶栏，避免外壳再占一行 */
  showAppChrome?: boolean
}) {
  const navigate = useNavigate()
  const [projectName, setProjectName] = useState('')
  const [showMinimap, setShowMinimap] = useState(true)
  const [snapToGrid, setSnapToGrid] = useState(false)
  const [hideEdges, setHideEdges] = useState(false)
  const [graph, setGraph] = useState<CanvasGraph | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const busyActionRef = useRef<string | null>(null)
  const [designPrompt, setDesignPrompt] = useState('')
  const [panel, setPanel] = useState<StagePanelRequest | null>(null)
  const [panelNode, setPanelNode] = useState<CanvasGraphNode | null>(null)
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
  /** 02 布局详情坞（不是 01 结构编辑器） */
  const [layoutDetail, setLayoutDetail] = useState<CanvasGraphNode | null>(null)
  /** 08 局部修改专注坞（对齐 01，非弹层） */
  const [localEdit, setLocalEdit] = useState<LocalEditSession | null>(null)
  /** 拖把线 / 生成按钮：引用上游生成下游的对话框 */
  const [generateDialog, setGenerateDialog] = useState<{
    node: CanvasGraphNode
    mode: GenerateDialogMode
  } | null>(null)
  /** 03 彩平等多项派生：拖把线松手菜单 */
  const [spawnMenu, setSpawnMenu] = useState<SpawnMenuState | null>(null)
  const connectStartRef = useRef<{
    nodeId: string | null
    handleType: string | null
  } | null>(null)
  /** 多图堆叠：全屏一览图库（不在画布上拆成一长列） */
  const [stackGallery, setStackGallery] = useState<StackGalleryState | null>(
    null,
  )
  /** 画布内拆开堆叠（次要；主路径为 stackGallery） */
  const [expandedStacks, setExpandedStacks] = useState<Set<string>>(
    () => new Set(),
  )
  const actionRef = useRef<(action: string, node: CanvasGraphNode | null) => void>(
    () => undefined,
  )
  const stage01ByJobRef = useRef(stage01ByJob)
  stage01ByJobRef.current = stage01ByJob
  const structureEditorRef = useRef(structureEditor)
  structureEditorRef.current = structureEditor
  const layoutDetailRef = useRef(layoutDetail)
  layoutDetailRef.current = layoutDetail
  const localEditRef = useRef(localEdit)
  localEditRef.current = localEdit
  const expandedStacksRef = useRef(expandedStacks)
  expandedStacksRef.current = expandedStacks
  const graphRef = useRef<CanvasGraph | null>(null)
  graphRef.current = graph
  /** 打破 useCanvasSkeletons ↔ applyGraph 循环依赖 */
  const applyGraphRef = useRef<
    (body: CanvasGraph, selected: string | null) => void
  >(() => undefined)
  const {
    skeletonSlots,
    skeletonSlotsRef,
    clearSkeletonGroup,
    spawnSkeletons,
    bindSkeletonsToJob,
    resetSkeletonsForRetry,
    mergeRestoredSkeletons,
  } = useCanvasSkeletons({
    projectId,
    graphRef,
    selectedId,
    applyGraph: (body, selected) => applyGraphRef.current(body, selected),
  })
  const loadSeqRef = useRef(0)
  const { fitView, zoomIn, zoomOut, setCenter, getNode } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const inStructureFocus = Boolean(structureEditor)
  const inLayoutDetail = Boolean(layoutDetail)
  const inLocalEdit = Boolean(localEdit)
  const inStackGallery = Boolean(stackGallery)
  /** 图库自带顶栏，计入 focus 以隐藏画布顶栏/底栏，给图片让高 */
  const inAnyFocus =
    inStructureFocus || inLayoutDetail || inLocalEdit || inStackGallery

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

  /** 点击堆叠 → 全屏图库一览全部图片（尽量铺满当前屏幕） */
  const openStackGallery = useCallback((node: CanvasGraphNode) => {
    const items = node.stackItems
    if (!items?.length) {
      setNotice('该堆叠没有可预览的图片')
      return
    }
    setContextMenu(null)
    setLayoutDetail(null)
    setLocalEdit(null)
    setStackGallery({
      stackKey: node.stackKey || node.id,
      items: [...items],
      title: node.label || node.title || undefined,
    })
    setNotice(`全屏预览 ${items.length} 张 · 点击任一张进入详情`)
  }, [])

  const closeStackGallery = useCallback(() => {
    setStackGallery(null)
  }, [])

  const collapseStack = useCallback((stackKey: string) => {
    setExpandedStacks((current) => {
      if (!current.has(stackKey)) return current
      const next = new Set(current)
      next.delete(stackKey)
      return next
    })
  }, [])

  const applyGraph = useCallback(
    (body: CanvasGraph, selected: string | null) => {
      // 永远合并 ref 里的最新骨架，防止异步 loadGraph 用空闭包冲掉占位框
      const built = buildCanvasFlow({
        body,
        skeletons: skeletonSlotsRef.current,
        expandedStacks: expandedStacksRef.current,
        stage01ConfirmedJobs: stage01ByJobRef.current,
      })
      setGraph(body)
      graphRef.current = body
      setDownstreamByAsset(built.parentIds)

      setNodes(
        built.displayNodes.map((item) => {
          const data: CanvasNodeData = {
            graphNode: item,
            actionCtx: item.actionCtx,
            showActions:
              (selected === item.id && !item.isStack) ||
              (Boolean(item.isSkeleton) &&
                (item.jobStatus === 'FAILED' ||
                  item.jobStatus === 'CANCELED')),
            onAction: (action: string, node: CanvasGraphNode) =>
              actionRef.current(action, node),
            onCollapseStack: collapseStack,
          }
          return {
            id: item.id,
            type: 'canvasCard',
            position: { x: item.x, y: item.y },
            data,
            style: { width: item.w },
            draggable: !item.isSkeleton,
          }
        }),
      )
      setEdges(
        built.edges.map((edge) =>
          edge.skeleton
            ? {
                id: edge.id,
                source: edge.source,
                target: edge.target,
                type: 'border' as const,
                animated: true,
                style: {
                  stroke: 'rgba(59,130,246,0.55)',
                  strokeWidth: 1.6,
                  strokeDasharray: '6 4',
                },
              }
            : {
                id: edge.id,
                source: edge.source,
                target: edge.target,
                type: 'border' as const,
                style: { stroke: 'rgba(255,255,255,0.28)', strokeWidth: 1.6 },
              },
        ),
      )
    },
    [setNodes, setEdges, collapseStack],
  )
  applyGraphRef.current = applyGraph

  // 骨架 / 堆叠展开态变化时重排；**不要** fitView，否则会打断用户缩放/平移
  useEffect(() => {
    const body = graphRef.current
    if (!body) return
    applyGraph(body, selectedId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skeletonSlots, expandedStacks])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const response = await apiFetch('/v1/projects')
        if (!response.ok || !active) return
        const body = (await response.json()) as Array<{
          id: string
          name?: string
        }>
        const list = Array.isArray(body) ? body : []
        const hit = list.find((p) => p.id === projectId)
        if (active && hit?.name) setProjectName(hit.name)
      } catch {
        /* 名称仅装饰，失败忽略 */
      }
    })()
    return () => {
      active = false
    }
  }, [projectId])

  const loadGraph = useCallback(
    async (opts?: { fit?: boolean }) => {
      if (!projectId) return
      const seq = ++loadSeqRef.current
      // 仅显式 fit:true 才重置视口（首次进入项目）；生成刷新默认保持用户当前缩放/平移
      const shouldFit = opts?.fit === true
      setLoading(true)
      setError('')
      try {
        // 仅加载本 project_id 的资产。不要 includeOrphans：
        // 否则会把全库 project_id 为空的「我的资产」并进任意新项目画布。
        const response = await apiFetch(
          `/v1/projects/${encodeURIComponent(projectId)}/canvas-graph`,
        )
        if (!response.ok) {
          throw new Error(`加载画布图谱失败：${response.status}`)
        }
        const body = (await response.json()) as CanvasGraph
        // 丢弃过期响应，避免冲掉更新的骨架
        if (seq !== loadSeqRef.current) return
        applyGraph(body, selectedId)
        if (shouldFit) {
          requestAnimationFrame(() => fitView({ padding: 0.18, duration: 200 }))
        }
      } catch (value) {
        if (seq !== loadSeqRef.current) return
        setError(value instanceof Error ? value.message : '加载失败')
      } finally {
        if (seq === loadSeqRef.current) setLoading(false)
      }
    },
    [projectId, applyGraph, selectedId, fitView],
  )

  useEffect(() => {
    void loadGraph({ fit: true })
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

  /** 01–08：图片详情坞；01 可再点图进入结构编辑器 */
  const openLayoutDetail = useCallback((node: CanvasGraphNode) => {
    if (!node.url && !node.thumbnailUrl) {
      setNotice('该节点没有可显示的图片')
      return
    }
    if (!canOpenStageDetail(normalizeStage(node))) {
      setNotice('当前节点阶段不支持图片详情页')
      return
    }
    setContextMenu(null)
    // 关闭结构编辑器，避免叠在详情上
    setStructureEditor(null)
    setLayoutDetail({ ...node })
    setSelectedId(node.id)
    const stage = normalizeStage(node)
    const label = stageLabel(stage)
    setNotice(
      stage === 'floorplan'
        ? `已打开 ${label} 预览 · 点击大图进入结构编辑`
        : `已打开 ${label} 详情（当前方案图已载入）`,
    )
  }, [])

  /** 01 专用：结构编辑器（FloorplanModule）——禁止 LAYOUT_AI / 彩平进入 */
  const openStructureEditor = useCallback(
    async (node: CanvasGraphNode) => {
      // 02–08 图片节点误点结构编辑 → 改开详情坞
      if (isStageImageDetailNode(node)) {
        openLayoutDetail(node)
        return
      }
      if (!isStage01Node(node)) {
        setNotice('结构编辑器仅用于 01 户型识别节点；02–08 请点击打开方案详情')
        return
      }
      if (!node.jobId) {
        setNotice('该节点缺少分析任务 ID，无法打开结构编辑器')
        return
      }
      // 服务端再验 job 类型，防止 jobId 指到 LAYOUT_AI
      try {
        const resp = await apiFetch(`/v1/jobs/${encodeURIComponent(node.jobId)}`, {
          cache: 'no-store',
        })
        if (resp.ok) {
          const job = (await resp.json()) as { type?: string }
          if (job.type && job.type !== 'FLOORPLAN_ANALYZE') {
            if (job.type === 'LAYOUT_AI' || job.type === 'LAYOUT') {
              openLayoutDetail(node)
              return
            }
            setNotice(`无法打开结构编辑器：任务类型为 ${job.type}`)
            return
          }
        }
      } catch {
        // 网络失败时仍按节点元数据尝试 01
      }
      setContextMenu(null)
      setLayoutDetail(null)
      setNotice('') // 避免预览 toast 残留成右上角空框
      setStructureEditor({ jobId: node.jobId, node })
    },
    [openLayoutDetail],
  )

  const exitLayoutDetail = useCallback(
    (opts?: { notice?: string; focusNodeId?: string }) => {
      const focusNodeId = opts?.focusNodeId ?? layoutDetailRef.current?.id
      setLayoutDetail(null)
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

  const exitLocalEdit = useCallback(
    (opts?: { notice?: string; focusNodeId?: string }) => {
      const focusNodeId =
        opts?.focusNodeId ?? localEditRef.current?.node.id
      setLocalEdit(null)
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

  /** 打开 08 局部修改专注坞（对齐 01，不走弹层） */
  const openLocalEditDock = useCallback(async (node: CanvasGraphNode) => {
    if (!node.assetId || !node.url) {
      setNotice('色调节点缺少图片，无法进入局部修改')
      return
    }
    setContextMenu(null)
    setPanel(null)
    setPanelNode(null)
    setLayoutDetail(null)
    setStructureEditor(null)
    setNotice('正在准备局部修改编辑器…')
    try {
      let versionId =
        typeof node.approvedVersionId === 'string'
          ? node.approvedVersionId
          : ''
      if (!versionId && node.variantId) {
        const approved = await approveVariantIdempotent({
          assetId: node.assetId,
          variantId: node.variantId,
        })
        versionId = approved.approvedVersionId
      }
      const resp = await apiFetch(
        `/v1/assets/${encodeURIComponent(node.assetId)}`,
        { cache: 'no-store' },
      )
      let spaceId = 'room_living'
      if (resp.ok) {
        const asset = (await resp.json()) as {
          metadata?: Record<string, unknown>
        }
        const meta = asset.metadata ?? {}
        const sid = meta.spaceId
        if (typeof sid === 'string' && sid.trim()) spaceId = sid.trim()
      }
      setLocalEdit({
        node: { ...node },
        sourceUrl: node.url,
        spaceId,
        assetId: node.assetId,
        versionId: versionId || '',
      })
      setSelectedId(node.id)
      setNotice('已进入 08 局部修改：红笔圈选区域并填写说明')
    } catch (value) {
      setNotice(value instanceof Error ? value.message : '无法打开局部修改')
    }
  }, [])

  useResumeActiveJobs({
    projectId,
    graphRef,
    selectedId,
    applyGraph,
    loadGraph,
    bindSkeletonsToJob,
    clearSkeletonGroup,
    mergeRestoredSkeletons,
    setNotice,
    setBusy,
    busyRef,
    busyActionRef,
  })

  const runAction = useCanvasRunAction({
    projectId,
    designPrompt,
    selectedId,
    graphRef,
    skeletonSlotsRef,
    stage01ByJobRef,
    busyRef,
    busyActionRef,
    setBusy,
    setNotice,
    setContextMenu,
    setPanel,
    setPanelNode,
    setSelectedId,
    setGenerateDialog,
    setSpawnMenu: () => setSpawnMenu(null),
    setStructureEditor,
    setNodes,
    applyGraph,
    loadGraph,
    openLayoutDetail,
    openStructureEditor,
    openLocalEditDock,
    spawnSkeletons,
    bindSkeletonsToJob,
    clearSkeletonGroup,
    resetSkeletonsForRetry,
  })

  actionRef.current = (action, node) => {
    void runAction(action, node)
  }


  // 单击堆叠 → 全屏图库；单击 01–08 方案图 → 详情坞（01 可再点图进结构编辑）
  /**
   * 打开指定派生动作（生成对话框 / 局部修改坞）
   * @returns true 表示已消费
   */
  const tryOpenSpawnFromNode = useCallback(
    (graphNode: CanvasGraphNode, preferredAction?: string) => {
      if (graphNode.isSkeleton || graphNode.isTemporary) return false

      const options = spawnOptionsForNode(graphNode)
      const primary = options[0] ?? primarySpawnForNode(graphNode)
      const action = preferredAction || primary?.action
      if (!action) return false

      const picked =
        options.find((item) => item.action === action) ?? primary ?? null

      const needsStage01 = action === 'generate_layout'
      const needsApproval =
        action !== 'generate_layout' &&
        (isSpawnDialogAction(action) || action === 'local_edit')

      if (needsStage01) {
        if (!graphNode.jobId || !stage01ByJobRef.current[graphNode.jobId]) {
          setNotice('请先确认结构后再拖出生成平面图')
          return false
        }
      } else if (needsApproval && !nodeHasApprovedSpawnSource(graphNode)) {
        setNotice('请先批准当前方案后再拖出派生下游')
        return false
      }

      const source = resolveSpawnSourceNode(graphNode)
      if (!source) {
        setNotice('当前节点无法派生')
        return false
      }

      setSelectedId(graphNode.id)
      setSpawnMenu(null)

      // 08：拖把线直接进入局部修改坞
      if (action === 'local_edit') {
        void openLocalEditDock(source)
        setNotice(picked?.notice ?? '进入局部修改')
        return true
      }

      // 04 轴侧 / 05 分空间 / 06 风格 / 07 色调：走勾选面板
      if (
        action === 'generate_axonometric' ||
        action === 'generate_space_render' ||
        action === 'generate_style_scheme' ||
        action === 'generate_tone_scheme'
      ) {
        void runAction(action, source)
        return true
      }

      const mode = dialogModeForAction(action)
      if (!mode) return false

      setGenerateDialog({ node: source, mode })
      setNotice(picked?.notice ?? '填写意向后点击箭头生成')
      return true
    },
    [openLocalEditDock, runAction],
  )

  /**
   * 拖把线松手：单项直接打开；多项（如 03→04/05）弹出「引用该节点生成」菜单
   */
  const tryOpenSpawnMenuOrDialog = useCallback(
    (graphNode: CanvasGraphNode, clientX: number, clientY: number) => {
      if (graphNode.isSkeleton || graphNode.isTemporary) return false
      const options = spawnOptionsForNode(graphNode)
      if (!options.length) return false

      const sample = options[0]
      if (sample.needsStage01) {
        if (!graphNode.jobId || !stage01ByJobRef.current[graphNode.jobId]) {
          setNotice('请先确认结构后再拖出生成平面图')
          return false
        }
      } else if (
        sample.needsApproval &&
        !nodeHasApprovedSpawnSource(graphNode)
      ) {
        setNotice('请先批准当前方案后再拖出派生下游')
        return false
      }

      setSelectedId(graphNode.id)
      setContextMenu(null)

      if (options.length === 1) {
        return tryOpenSpawnFromNode(graphNode, options[0].action)
      }

      // 多项：在松手位置弹出菜单
      const pos = clampMenuPosition(clientX, clientY, 220, 160)
      setSpawnMenu({
        x: pos.x,
        y: pos.y,
        node: graphNode,
        options,
      })
      setNotice('选择要生成的下游类型')
      return true
    },
    [tryOpenSpawnFromNode],
  )

  const onConnectStart: OnConnectStart = useCallback((_event, params) => {
    connectStartRef.current = {
      nodeId: params.nodeId,
      handleType: params.handleType,
    }
  }, [])

  const onConnect: (connection: Connection) => void = useCallback(() => {
    // 图谱边由后端资产关系决定；此处仅消费拖出交互，不落真实边
    connectStartRef.current = null
  }, [])

  const onConnectEnd: OnConnectEnd = useCallback(
    (event) => {
      const start = connectStartRef.current
      connectStartRef.current = null
      if (!start?.nodeId || start.handleType !== 'source') return

      const targetEl = event.target as Element | null
      // 落到其它节点上则忽略（不当作「空白处生成」）
      if (targetEl?.closest?.('.react-flow__node')) return

      const rfNode = nodes.find((n) => n.id === start.nodeId)
      if (!rfNode) return
      const graphNode = (rfNode.data as CanvasNodeData).graphNode

      let clientX = 0
      let clientY = 0
      if ('clientX' in event && typeof event.clientX === 'number') {
        clientX = event.clientX
        clientY = event.clientY
      } else if ('changedTouches' in event && event.changedTouches?.[0]) {
        clientX = event.changedTouches[0].clientX
        clientY = event.changedTouches[0].clientY
      }
      tryOpenSpawnMenuOrDialog(graphNode, clientX, clientY)
    },
    [nodes, tryOpenSpawnMenuOrDialog],
  )

  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const graphNode = (node.data as CanvasNodeData).graphNode
      setSelectedId(node.id)
      setContextMenu(null)
      if (graphNode.isStack && graphNode.stackItems?.length) {
        openStackGallery(graphNode)
        return
      }
      if (graphNode.isStack) return
      if (isStageImageDetailNode(graphNode) || isStage01Node(graphNode)) {
        openLayoutDetail(graphNode)
      }
    },
    [openLayoutDetail, openStackGallery],
  )

  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const graphNode = (node.data as CanvasNodeData).graphNode
      setSelectedId(node.id)
      if (graphNode.isStack && graphNode.stackItems?.length) {
        openStackGallery(graphNode)
        return
      }
      // 01–08：与单击一致进图片详情（01 再点图进结构编辑器）
      if (isStageImageDetailNode(graphNode) || isStage01Node(graphNode)) {
        openLayoutDetail(graphNode)
        return
      }
      if (graphNode.url) {
        window.open(assetUrl(graphNode.url), '_blank', 'noopener,noreferrer')
      }
    },
    [openLayoutDetail, openStackGallery],
  )

  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  /** 右键点击原始坐标，用于真实尺寸测量后再贴边（避免用已夹紧坐标二次偏移） */
  const contextMenuOriginRef = useRef({ x: 0, y: 0 })

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
    const stackHasApproved = nodeHasApprovedSpawnSource(contextMenu.node)
    const ctx: ActionContext = {
      hasDownstream: contextMenu.node.assetId
        ? downstreamByAsset.has(contextMenu.node.assetId)
        : false,
      isApprovedVariant:
        Boolean(contextMenu.node.approved) || stackHasApproved,
      stage01Confirmed:
        stage === 'floorplan' && contextMenu.node.jobId
          ? Boolean(stage01ByJob[contextMenu.node.jobId])
          : undefined,
    }
    // 右键派生动作：可点则走拖把线同款对话框；未满足前置时仍可点并引导
    return listNodeActions(contextMenu.node, ctx).map((item) => {
      if (item.action === 'generate_layout') {
        return {
          ...item,
          enabled: true,
          reason: item.enabled
            ? item.reason
            : '将打开生成平面图对话框（需先确认结构）',
        }
      }
      if (isSpawnDialogAction(item.action) && stackHasApproved) {
        return {
          ...item,
          enabled: true,
          reason: undefined,
        }
      }
      return item
    })
  }, [contextMenu, downstreamByAsset, stage01ByJob])

  const openContextMenu = useCallback(
    (clientX: number, clientY: number, node: CanvasGraphNode | null) => {
      contextMenuOriginRef.current = { x: clientX, y: clientY }
      // 先按估算高度贴边，渲染后再用真实尺寸校正
      const estimateH = node ? 360 : 80
      const pos = clampMenuPosition(clientX, clientY, 240, estimateH)
      setContextMenu({ x: pos.x, y: pos.y, node })
    },
    [],
  )

  // 菜单挂载后按真实高度再夹一次，避免画布底部节点右键被裁切
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return
    const rect = contextMenuRef.current.getBoundingClientRect()
    const origin = contextMenuOriginRef.current
    const pos = clampMenuPosition(
      origin.x,
      origin.y,
      rect.width || 240,
      rect.height || 360,
    )
    if (pos.x !== contextMenu.x || pos.y !== contextMenu.y) {
      setContextMenu((cur) => (cur ? { ...cur, x: pos.x, y: pos.y } : cur))
    }
  }, [contextMenu?.node, contextActions.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const onNodeContextMenu: NodeMouseHandler = useCallback(
    (event, node) => {
      event.preventDefault()
      event.stopPropagation()
      const graphNode = (node.data as CanvasNodeData).graphNode
      setSelectedId(node.id)
      openContextMenu(event.clientX, event.clientY, graphNode)
    },
    [openContextMenu],
  )

  const onPaneClick = useCallback(() => {
    setSelectedId(null)
    setContextMenu(null)
    setSpawnMenu(null)
  }, [])

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault()
      openContextMenu(event.clientX, event.clientY, null)
    },
    [openContextMenu],
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
        if (localEditRef.current) {
          exitLocalEdit({ notice: '已退出局部修改' })
          return
        }
        if (stackGallery) {
          setStackGallery(null)
          return
        }
        if (layoutDetailRef.current) {
          exitLayoutDetail()
          return
        }
        setContextMenu(null)
        setSpawnMenu(null)
        setPanel(null)
        setSelectedId(null)
        return
      }
      if (
        structureEditorRef.current ||
        layoutDetailRef.current ||
        localEditRef.current ||
        stackGallery
      )
        return
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
  }, [
    selectedId,
    graph,
    runAction,
    exitStructureFocus,
    exitLayoutDetail,
    exitLocalEdit,
    stackGallery,
  ])

  const selectedNode = graph?.nodes.find((n) => n.id === selectedId) ?? null
  const focusConfirmed = structureEditor
    ? Boolean(stage01ByJob[structureEditor.jobId])
    : false
  // 详情坞内展示的布局节点：优先用图谱里刷新后的版本（含批准态）
  const layoutDetailLive =
    (layoutDetail &&
      graph?.nodes.find((n) => n.id === layoutDetail.id)) ||
    layoutDetail

  return (
    <div
      className={`canvas-theme canvas-shell${inAnyFocus ? ' is-structure-focus' : ''}${
        showAppChrome ? ' is-app-chrome' : ''
      }`}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: showAppChrome ? '100%' : 560,
        borderRadius: showAppChrome ? 0 : 16,
        overflow: 'hidden',
        border: showAppChrome ? 'none' : '1px solid var(--canvas-border)',
      }}
    >
      {/* 图谱模式：风暴式 chrome（左上项目 / 左下视图 / 底中 +） */}
      {showAppChrome && !inAnyFocus && !inStackGallery ? (
        <CanvasChrome
          projectId={projectId}
          projectName={projectName}
          zoom={zoom}
          busy={busy}
          showMinimap={showMinimap}
          snapToGrid={snapToGrid}
          hideEdges={hideEdges}
          onToggleMinimap={() => setShowMinimap((v) => !v)}
          onToggleSnap={() => setSnapToGrid((v) => !v)}
          onToggleHideEdges={() => setHideEdges((v) => !v)}
          onOrganize={() => {
            if (graphRef.current) {
              applyGraph(graphRef.current, selectedId)
            }
            requestAnimationFrame(() => fitView({ padding: 0.18, duration: 280 }))
            setNotice('已整理画布布局')
          }}
          onZoomIn={() => zoomIn({ duration: 120 })}
          onZoomOut={() => zoomOut({ duration: 120 })}
          onFitView={() => fitView({ padding: 0.18, duration: 200 })}
          onUploadFloorplan={() => void runAction('upload_floorplan', null)}
          onOpenAssets={() => {
            if (onOpenAssets) onOpenAssets()
            else navigate('/assets')
          }}
          onNotice={setNotice}
        />
      ) : null}

      {/* 专注模式顶栏（结构 / 详情 / 局部）；图谱模式不占顶栏 */}
      {inAnyFocus && !inStackGallery ? (
        <div className="canvas-topbar canvas-topbar-oneline">
          <div className="canvas-topbar-row">
            {inStructureFocus ? (
              <>
                <span className="canvas-pill canvas-topbar-pill">
                  01 结构
                  {focusConfirmed ? ' · 已确认' : ' · 编辑中'}
                </span>
                <span className="canvas-topbar-title">
                  {structureEditor?.node.title ||
                    structureEditor?.node.label ||
                    '户型分析'}
                </span>
              </>
            ) : inLocalEdit && localEdit ? (
              <>
                <span className="canvas-pill canvas-topbar-pill">
                  08 局部 · 标注中
                </span>
                <span className="canvas-topbar-title">
                  {(
                    localEdit.node.label ||
                    localEdit.node.variantId ||
                    '色调方案'
                  ).replaceAll('_', ' ')}
                </span>
              </>
            ) : layoutDetailLive ? (
              <>
                <span className="canvas-pill canvas-topbar-pill">
                  {stageLabel(normalizeStage(layoutDetailLive))} 详情
                  {layoutDetailLive.approved ? ' · 已批准' : ''}
                </span>
                <span className="canvas-topbar-title">
                  {(
                    layoutDetailLive.label ||
                    layoutDetailLive.variantId ||
                    '方案'
                  ).replaceAll('_', ' ')}
                </span>
              </>
            ) : null}
            <span className="canvas-topbar-spacer" />
            <button
              type="button"
              className="canvas-btn canvas-btn-primary canvas-topbar-btn"
              onClick={() => {
                if (inStructureFocus) {
                  exitStructureFocus({
                    notice: focusConfirmed
                      ? '已返回图谱'
                      : '已返回图谱（结构尚未确认）',
                  })
                } else if (inLocalEdit) {
                  exitLocalEdit({ notice: '已退出局部修改' })
                } else {
                  exitLayoutDetail()
                }
              }}
            >
              完成
            </button>
          </div>
        </div>
      ) : null}

      <div className="canvas-body">
        {/* 图谱常驻挂载，focus 时仅隐藏，保留视口 */}
        <div
          className={`canvas-graph-pane${inAnyFocus ? ' is-parked' : ''}`}
          aria-hidden={inAnyFocus}
        >
          <ReactFlow
            nodes={nodes}
            edges={hideEdges ? [] : edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={canvasNodeTypes}
            edgeTypes={canvasEdgeTypes}
            defaultEdgeOptions={{ type: 'border' }}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onNodeContextMenu={onNodeContextMenu}
            onPaneClick={onPaneClick}
            onPaneContextMenu={onPaneContextMenu}
            onConnectStart={onConnectStart}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onMove={(_, viewport) => setZoom(viewport.zoom)}
            minZoom={0.05}
            maxZoom={16}
            zoomOnDoubleClick={false}
            snapToGrid={snapToGrid}
            snapGrid={[16, 16]}
            connectionRadius={96}
            proOptions={{ hideAttribution: true }}
            style={{ width: '100%', height: '100%' }}
          >
            <Background
              id="dots"
              variant={BackgroundVariant.Dots}
              gap={showAppChrome ? 30 : 22}
              size={showAppChrome ? 1.2 : 1.4}
              color={
                showAppChrome
                  ? 'rgba(255,255,255,0.14)'
                  : 'rgba(255,255,255,0.09)'
              }
              bgColor={showAppChrome ? '#181818' : '#0a0a0d'}
            />
            {showMinimap ? (
              <MiniMap
                pannable
                zoomable
                style={{
                  background: showAppChrome ? '#1c1c20' : '#12131a',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 12,
                }}
                maskColor="rgba(10,10,13,0.55)"
                nodeColor={() => 'rgba(255,255,255,0.22)'}
              />
            ) : null}
            {/* 缩放/控件改由 CanvasChrome 左下与底中提供 */}
            {!showAppChrome ? <Controls showInteractive={false} /> : null}
          </ReactFlow>

          {!showAppChrome ? (
            <div className="canvas-bottombar">
              <div className="canvas-toolbar canvas-bottombar-toolbar">
                <button
                  type="button"
                  className="canvas-btn canvas-topbar-btn"
                  title="缩小"
                  onClick={() => zoomOut({ duration: 120 })}
                >
                  −
                </button>
                <button
                  type="button"
                  className="canvas-btn canvas-topbar-btn"
                  title="适应画布 · 滚轮最高 1600%"
                  onClick={() => fitView({ padding: 0.18 })}
                >
                  {zoomPercent(zoom)}%
                </button>
                <button
                  type="button"
                  className="canvas-btn canvas-topbar-btn"
                  title="放大"
                  onClick={() => zoomIn({ duration: 120 })}
                >
                  +
                </button>
                {selectedNode ? (
                  <span className="canvas-pill canvas-topbar-pill">
                    已选{' '}
                    {(selectedNode.label || selectedNode.variantId || '')
                      .replaceAll('_', ' ')
                      .slice(0, 18)}
                  </span>
                ) : (
                  <span className="canvas-pill canvas-topbar-pill canvas-muted-pill">
                    右键上传 · 单击节点放大
                  </span>
                )}
                {busy ? (
                  <span className="canvas-pill canvas-topbar-pill">执行中…</span>
                ) : null}
              </div>
            </div>
          ) : null}

          {!loading &&
          graph &&
          graph.nodeCount === 0 &&
          !skeletonSlots.length ? (
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

        {/* 01 结构专注坞：全宽主区最大化图纸（返回在顶栏） */}
        {structureEditor ? (
          <div className="canvas-structure-dock is-fullwidth">
            <div className="canvas-structure-main">
              <FloorplanModule
                key={structureEditor.jobId}
                presentation="canvas-focus"
                resumeAnalysisJobId={structureEditor.jobId}
                resumeImageUrl={
                  structureEditor.node.url ||
                  structureEditor.node.thumbnailUrl ||
                  null
                }
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

        {/* 01–08 方案详情坞：01 点图进结构编辑；02–08 批准/派生 */}
        {layoutDetailLive && !localEdit ? (
          <LayoutDetailDock
            node={layoutDetailLive}
            busy={busy}
            onBack={() => exitLayoutDetail()}
            onApprove={() => {
              void runAction('approve', layoutDetailLive)
            }}
            onUnapprove={() => {
              void runAction('unapprove', layoutDetailLive)
            }}
            primaryActions={(() => {
              const target = layoutDetailLive
              const stage = normalizeStage(target)
              const runDerived = (action: string) => {
                void (async () => {
                  // 01：编辑结构 / 生成布局
                  if (action === 'view_structure' || action === 'edit_structure') {
                    setLayoutDetail(null)
                    await openStructureEditor(target)
                    return
                  }
                  if (action === 'generate_layout') {
                    exitLayoutDetail({ focusNodeId: target.id })
                    await runAction('generate_layout', target)
                    return
                  }
                  // 派生动作：先尽量批准，再回图谱弹对话框 / 进坞（与拖把线一致）
                  if (isSpawnDialogAction(action) || action === 'local_edit') {
                    if (
                      action !== 'generate_layout' &&
                      !isVariantApproved(target)
                    ) {
                      await runAction('approve', target)
                    }
                    if (action === 'local_edit') {
                      setLayoutDetail(null)
                      await runAction(action, target)
                      return
                    }
                    exitLayoutDetail({ focusNodeId: target.id })
                    await runAction(action, target)
                    return
                  }
                  // 先尽量批准，再派生（busy 用 ref，可连续 await）
                  if (!target.approved) {
                    await runAction('approve', target)
                  }
                  exitLayoutDetail({ focusNodeId: target.id })
                  await runAction(action, target)
                })()
              }
              return primaryDeriveActionsForStage(stage).map((item) => ({
                ...item,
                key: item.action,
                disabled:
                  item.action === 'view_structure' ||
                  item.action === 'edit_structure'
                    ? !target.jobId
                    : item.action === 'generate_layout'
                      ? !target.jobId
                      : !target.assetId,
                onClick: () => runDerived(item.action),
              }))
            })()}
            onOpenFull={() => {
              // 已在详情内：直接开原图，避免再次 openLayoutDetail
              if (layoutDetailLive.url) {
                window.open(
                  assetUrl(layoutDetailLive.url),
                  '_blank',
                  'noopener,noreferrer',
                )
              }
            }}
            onDownload={() => {
              void runAction('download', layoutDetailLive)
            }}
            onImageClick={
              normalizeStage(layoutDetailLive) === 'floorplan'
                ? () => {
                    const target = layoutDetailLive
                    setLayoutDetail(null)
                    void openStructureEditor(target)
                  }
                : undefined
            }
          />
        ) : null}

        {/* 08 局部修改专注坞：对齐 01 结构编辑体验 */}
        {localEdit ? (
          <LocalEditDock
            session={localEdit}
            busy={busy}
            onBack={() => exitLocalEdit({ notice: '已退出局部修改' })}
            onSubmit={(markFile, editPrompt) => {
              const target = localEdit.node
              setLocalEdit(null)
              void runAction('local_edit', target, { markFile, editPrompt })
            }}
          />
        ) : null}

        {/* 多图堆叠：全屏一览（如 05 分空间 11 张） */}
        {stackGallery ? (
          <StackGallery
            gallery={stackGallery}
            onClose={closeStackGallery}
            onSelect={(node) => {
              setStackGallery(null)
              openLayoutDetail(node)
            }}
          />
        ) : null}
      </div>

      {error && !inAnyFocus ? (
        <div className="canvas-toast canvas-toast-error">{error}</div>
      ) : null}
      {notice ? <div className="canvas-toast">{notice}</div> : null}

      {!inAnyFocus && contextMenu
        ? createPortal(
            <div
              ref={contextMenuRef}
              className="canvas-theme canvas-card canvas-context-menu"
              style={{
                position: 'fixed',
                left: contextMenu.x,
                top: contextMenu.y,
                zIndex: 10000,
              }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              {contextActions.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  disabled={'enabled' in item ? !item.enabled : false}
                  title={'reason' in item ? item.reason : undefined}
                  onClick={() => {
                    const node = contextMenu.node
                    setContextMenu(null)
                    // 右键派生与拖把线共用生成对话框
                    if (
                      node &&
                      (isSpawnDialogAction(item.action) ||
                        item.action === 'local_edit')
                    ) {
                      if (tryOpenSpawnFromNode(node, item.action)) return
                      if (item.action === 'generate_layout') {
                        setNotice('请先在结构编辑器中确认结构后再生成布局')
                        void openStructureEditor(node)
                        return
                      }
                      setNotice('请先批准当前方案后再派生下游')
                      return
                    }
                    void runAction(item.action, node)
                  }}
                  className="canvas-context-item"
                >
                  <span>{item.label}</span>
                  {'shortcut' in item && item.shortcut ? (
                    <span className="canvas-muted">{item.shortcut}</span>
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}

      {/* 拖把线多项派生：引用该节点生成 */}
      {!inAnyFocus && spawnMenu ? (
        <SpawnMenu
          menu={spawnMenu}
          onClose={() => setSpawnMenu(null)}
          onPick={(node, action) => {
            if (!tryOpenSpawnFromNode(node, action)) {
              setNotice('无法打开生成对话框，请先检查批准状态')
            }
          }}
        />
      ) : null}

      {generateDialog ? (
        <GenerateLayoutDialog
          node={generateDialog.node}
          mode={generateDialog.mode}
          busy={busy}
          initialPrompt={designPrompt}
          onCancel={() => {
            if (!busy) setGenerateDialog(null)
          }}
          onSubmit={({ designPrompt: prompt, modelId, styleId }) => {
            const { node, mode } = generateDialog
            const composed = composeLayoutDesignPrompt({
              designPrompt: prompt,
              modelId,
              styleId,
              mode,
            })
            setDesignPrompt(composed)
            setGenerateDialog(null)
            const action = actionForDialogMode(mode)
            void runAction(action, node, {
              designPrompt: composed,
              spawnDialogConfirmed: true,
            })
          }}
        />
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
            const node = panelNode
            setPanel(null)
            setPanelNode(null)
            void runAction('upload_floorplan_submit', node, {
              file,
              planWidthMm,
              planDepthMm,
            })
          }}
          onSubmitSpaces={(spaceIds) => {
            const node = panelNode
            setPanel(null)
            setPanelNode(null)
            void runAction('generate_space_render', node, {
              selectedSpaceIds: spaceIds,
              // 已选房：跳过通用生成对话框与再次选房
              spawnDialogConfirmed: true,
            })
          }}
          onSubmitStyles={(variantIds) => {
            const node = panelNode
            setPanel(null)
            setPanelNode(null)
            void runAction('generate_style_scheme', node, {
              selectedStyleVariants: variantIds,
              spawnDialogConfirmed: true,
            })
          }}
          onSubmitTones={(variantIds) => {
            const node = panelNode
            setPanel(null)
            setPanelNode(null)
            void runAction('generate_tone_scheme', node, {
              selectedToneVariants: variantIds,
              spawnDialogConfirmed: true,
            })
          }}
          onSubmitAxonometrics={(variantIds) => {
            const node = panelNode
            setPanel(null)
            setPanelNode(null)
            void runAction('generate_axonometric', node, {
              selectedAxonometricVariants: variantIds,
              spawnDialogConfirmed: true,
            })
          }}
          onSubmitLocalEdit={(markFile, editPrompt) => {
            // 兼容旧弹层路径（主路径已改专注坞）
            const node = panelNode
            setPanel(null)
            setPanelNode(null)
            void runAction('local_edit', node, { markFile, editPrompt })
          }}
        />
      ) : null}
    </div>
  )
}


export default function ProjectCanvas(props: {
  projectId: string
  onOpenAssets?: () => void
  showAppChrome?: boolean
}) {
  return (
    <ReactFlowProvider>
      <ProjectCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
