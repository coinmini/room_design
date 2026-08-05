import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
import LayoutDetailDock from './LayoutDetailDock'
import LocalEditDock, { type LocalEditSession } from './LocalEditDock'
import { approveVariantIdempotent } from '../workflow/actions'
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
import {
  isImageDetailStage,
  primaryDeriveActionsForStage,
} from './stageDetail'
import {
  applyImageStacks,
  remapEdgesForStacks,
  stackEndpointMap,
} from './stackMath'
import type { CanvasGraph, CanvasGraphNode } from './types'
import { normalizeStage, stageLabel } from './types'

type ContextMenuState = {
  x: number
  y: number
  node: CanvasGraphNode | null
} | null

/** 右键菜单贴边：避免画布底部/右侧被裁切 */
function clampMenuPosition(
  clientX: number,
  clientY: number,
  menuWidth: number,
  menuHeight: number,
) {
  const pad = 10
  const vw = window.innerWidth
  const vh = window.innerHeight
  let x = clientX
  let y = clientY
  if (x + menuWidth + pad > vw) x = Math.max(pad, vw - menuWidth - pad)
  if (y + menuHeight + pad > vh) y = Math.max(pad, vh - menuHeight - pad)
  if (x < pad) x = pad
  if (y < pad) y = pad
  return { x, y }
}

/** 生成中占位：一点击就显示，避免「后台在跑、界面没反应」 */
type SkeletonSlot = {
  id: string
  groupId: string
  label: string
  /** 落在哪一列（layout / color_plan …） */
  workflowStage: string
  parentAssetId?: string
  /** 画布父节点 id，用于连线 */
  parentNodeId?: string
  /** 绑定到真实 job 后写入 */
  jobId?: string
}

function expectedSkeletonSlots(
  action: string,
  parent: CanvasGraphNode | null,
): Omit<SkeletonSlot, 'id' | 'groupId'>[] {
  const parentAssetId = parent?.assetId || undefined
  const parentNodeId = parent?.id
  if (action === 'generate_layout') {
    return [
      {
        label: '布局方案 1',
        workflowStage: 'layout',
        parentAssetId,
        parentNodeId,
      },
      {
        label: '布局方案 2',
        workflowStage: 'layout',
        parentAssetId,
        parentNodeId,
      },
    ]
  }
  if (action === 'generate_color_plan') {
    return [1, 2, 3, 4].map((n) => ({
      label: `彩平方案 ${n}`,
      workflowStage: 'color_plan',
      parentAssetId,
      parentNodeId,
    }))
  }
  if (action === 'generate_axonometric') {
    return [1, 2, 3].map((n) => ({
      label: `轴侧 ${n}`,
      workflowStage: 'axonometric',
      parentAssetId,
      parentNodeId,
    }))
  }
  if (action === 'generate_style_scheme') {
    return [1, 2, 3].map((n) => ({
      label: `风格 ${n}`,
      workflowStage: 'style_scheme',
      parentAssetId,
      parentNodeId,
    }))
  }
  if (action === 'generate_tone_scheme') {
    return [1, 2, 3].map((n) => ({
      label: `色调 ${n}`,
      workflowStage: 'tone_scheme',
      parentAssetId,
      parentNodeId,
    }))
  }
  if (action === 'generate_space_render') {
    return [
      {
        label: '分空间生成中…',
        workflowStage: 'space_render',
        parentAssetId,
        parentNodeId,
      },
    ]
  }
  if (action === 'local_edit') {
    return [
      {
        label: '局部修改中…',
        workflowStage: 'local_edit',
        parentAssetId,
        parentNodeId,
      },
    ]
  }
  if (action === 'upload_floorplan_submit' || action === 'reanalyze') {
    return [
      {
        label: '户型识别中…',
        workflowStage: 'floorplan',
        parentAssetId,
        parentNodeId,
      },
    ]
  }
  return [
    {
      label: '生成中…',
      workflowStage: 'other',
      parentAssetId,
      parentNodeId,
    },
  ]
}

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
  const busyRef = useRef(false)
  const busyActionRef = useRef<string | null>(null)
  const [designPrompt, setDesignPrompt] = useState('')
  const [panel, setPanel] = useState<StagePanelRequest | null>(null)
  const [panelNode, setPanelNode] = useState<CanvasGraphNode | null>(null)
  const [skeletonSlots, setSkeletonSlots] = useState<SkeletonSlot[]>([])
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
  /** 多图堆叠（02–07 等同批 ≥2 张）：已展开的 stackKey 集合 */
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
  /** 始终读最新骨架，避免 loadGraph 闭包把占位框冲掉 */
  const skeletonSlotsRef = useRef<SkeletonSlot[]>([])
  skeletonSlotsRef.current = skeletonSlots
  const expandedStacksRef = useRef(expandedStacks)
  expandedStacksRef.current = expandedStacks
  const graphRef = useRef<CanvasGraph | null>(null)
  graphRef.current = graph
  const loadSeqRef = useRef(0)
  const { fitView, zoomIn, zoomOut, setCenter, getNode } = useReactFlow()
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const inStructureFocus = Boolean(structureEditor)
  const inLayoutDetail = Boolean(layoutDetail)
  const inLocalEdit = Boolean(localEdit)
  const inAnyFocus = inStructureFocus || inLayoutDetail || inLocalEdit

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

  const expandStack = useCallback((stackKey: string) => {
    setExpandedStacks((current) => {
      if (current.has(stackKey)) return current
      const next = new Set(current)
      next.add(stackKey)
      return next
    })
    setNotice('已展开堆叠：显示全部图片')
  }, [])

  const collapseStack = useCallback((stackKey: string) => {
    setExpandedStacks((current) => {
      if (!current.has(stackKey)) return current
      const next = new Set(current)
      next.delete(stackKey)
      return next
    })
    setNotice('已收起为堆叠')
  }, [])

  const applyGraph = useCallback(
    (body: CanvasGraph, selected: string | null) => {
      // 永远合并 ref 里的最新骨架，防止异步 loadGraph 用空闭包冲掉占位框
      const skeletons = skeletonSlotsRef.current
      setGraph(body)
      graphRef.current = body
      const parentIds = new Set<string>()
      for (const edge of body.edges) {
        if (edge.sourceAssetId) parentIds.add(edge.sourceAssetId)
      }
      setDownstreamByAsset(parentIds)

      const skeletonNodes: CanvasGraphNode[] = skeletons.map((item) => ({
        id: `skeleton:${item.id}`,
        jobId: item.jobId,
        variantId: item.id,
        label: item.label,
        title: item.label,
        isSkeleton: true,
        workflowStage: item.workflowStage,
        parentAssetId: item.parentAssetId,
        moduleKey:
          item.workflowStage === 'layout'
            ? 'layout'
            : item.workflowStage === 'floorplan'
              ? 'floorplan'
              : 'ai_workflow',
      }))

      const withSkeletons: CanvasGraphNode[] = [...body.nodes, ...skeletonNodes]
      // 同批 ≥2 张（布局/彩平/轴侧/分空间/风格/色调）：默认堆叠，展开后拆开
      const displayNodes = applyImageStacks(
        withSkeletons,
        expandedStacksRef.current,
      )
      const laid = layoutGraphByStage(displayNodes)
      const flowEdges = remapEdgesForStacks(
        resolveFlowEdges(body.nodes, body.edges),
        stackEndpointMap(withSkeletons, displayNodes),
      )
      const confirmedJobs = stage01ByJobRef.current

      const parentIdSet = new Set(body.nodes.map((n) => n.id))
      const displayIdSet = new Set(displayNodes.map((n) => n.id))
      const endpointMap = stackEndpointMap(withSkeletons, displayNodes)
      const skeletonEdges = skeletons
        .filter((s) => s.parentNodeId && parentIdSet.has(s.parentNodeId))
        .map((s) => {
          const source =
            endpointMap.get(s.parentNodeId!) ?? s.parentNodeId!
          const target = `skeleton:${s.id}`
          return {
            id: `sk-edge:${s.id}`,
            source,
            target: displayIdSet.has(target)
              ? target
              : endpointMap.get(target) ?? target,
          }
        })
        .filter((e) => displayIdSet.has(e.source) && displayIdSet.has(e.target))

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
            showActions:
              selected === item.id && !item.isSkeleton && !item.isStack,
            onAction: (action: string, node: CanvasGraphNode) =>
              actionRef.current(action, node),
            onExpandStack: expandStack,
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
      setEdges([
        ...flowEdges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'default' as const,
          style: { stroke: 'rgba(255,255,255,0.22)', strokeWidth: 1.5 },
        })),
        ...skeletonEdges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'default' as const,
          animated: true,
          style: {
            stroke: 'rgba(59,130,246,0.55)',
            strokeWidth: 1.5,
            strokeDasharray: '6 4',
          },
        })),
      ])
    },
    [setNodes, setEdges, expandStack, collapseStack],
  )

  // 骨架 / 堆叠展开态变化时重排；**不要** fitView，否则会打断用户缩放/平移
  useEffect(() => {
    const body = graphRef.current
    if (!body) return
    applyGraph(body, selectedId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skeletonSlots, expandedStacks])

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

  const isStage01Node = useCallback((node: CanvasGraphNode) => {
    const stage = normalizeStage(node)
    // 绝不能把 layout_plan / LAYOUT_AI 当成 01
    if (
      node.moduleKey === 'layout' ||
      node.assetType === 'layout_plan' ||
      stage === 'layout'
    ) {
      return false
    }
    // 02–08 图片阶段不得进 01
    if (isImageDetailStage(stage)) {
      return false
    }
    return (
      stage === 'floorplan' ||
      node.moduleKey === 'floorplan' ||
      node.assetType === 'floorplan_analysis'
    )
  }, [])

  /** 可进图片详情坞的节点：02–08 方案图 */
  const isStageImageDetailNode = useCallback((node: CanvasGraphNode) => {
    return isImageDetailStage(normalizeStage(node))
  }, [])

  /** 02–08：图片详情坞，自动载入当前方案图 */
  const openLayoutDetail = useCallback((node: CanvasGraphNode) => {
    if (!node.url && !node.thumbnailUrl) {
      setNotice('该节点没有可显示的图片')
      return
    }
    if (!isImageDetailStage(normalizeStage(node))) {
      setNotice('当前节点阶段不支持图片详情页')
      return
    }
    setContextMenu(null)
    // 关闭 01 结构编辑器，避免叠在详情上
    setStructureEditor(null)
    setLayoutDetail({ ...node })
    setSelectedId(node.id)
    const label = stageLabel(normalizeStage(node))
    setNotice(`已打开 ${label} 详情（当前方案图已载入）`)
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
      setStructureEditor({ jobId: node.jobId, node })
    },
    [isStage01Node, isStageImageDetailNode, openLayoutDetail],
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

  const clearSkeletonGroup = useCallback((groupId: string) => {
    setSkeletonSlots((current) => {
      const next = current.filter((s) => s.groupId !== groupId)
      skeletonSlotsRef.current = next
      return next
    })
  }, [])

  const spawnSkeletons = useCallback(
    (action: string, parent: CanvasGraphNode | null): string => {
      const groupId = `gen-${action}-${Date.now()}`
      const slots = expectedSkeletonSlots(action, parent).map((slot, index) => ({
        ...slot,
        id: `${groupId}-${index + 1}`,
        groupId,
      }))
      setSkeletonSlots((current) => {
        const next = [...current, ...slots]
        skeletonSlotsRef.current = next
        return next
      })
      // 同步立即上屏（不等 useEffect），避免被异步 load 抢先
      const body = graphRef.current
      if (body) {
        // 微任务后 apply：等 ref 写入
        queueMicrotask(() => {
          applyGraph(body, parent?.id ?? null)
        })
      }
      return groupId
    },
    [applyGraph],
  )

  const bindSkeletonsToJob = useCallback(
    (groupId: string, job: Job) => {
      setSkeletonSlots((current) => {
        const next = current.map((slot) =>
          slot.groupId === groupId ? { ...slot, jobId: job.id } : slot,
        )
        skeletonSlotsRef.current = next
        return next
      })
    },
    [],
  )

  const runAction = useCallback(
    async (
      action: string,
      node: CanvasGraphNode | null,
      extras?: Parameters<typeof executeCanvasAction>[0]['extras'],
    ) => {
      setContextMenu(null)
      setNotice('')

      // 防连点：用 ref 判断，避免 await 后闭包 busy 仍为 true
      if (
        busyRef.current &&
        [
          'generate_layout',
          'generate_color_plan',
          'generate_axonometric',
          'generate_space_render',
          'generate_style_scheme',
          'generate_tone_scheme',
          'local_edit',
          'upload_floorplan_submit',
        ].includes(action)
      ) {
        setNotice(
          busyActionRef.current
            ? `「${actionLabel(busyActionRef.current)}」进行中，请勿重复点击`
            : '任务进行中，请勿重复点击',
        )
        return
      }

      busyRef.current = true
      setBusy(true)
      let skeletonGroupId: string | null = null
      try {
        // 面板已提交完整参数 → 立刻关掉浮层，避免生成过程中仍盖在画布上
        if (
          (action === 'generate_space_render' && extras?.selectedSpaceIds) ||
          (action === 'local_edit' && extras?.markFile) ||
          (action === 'upload_floorplan_submit' && extras?.file)
        ) {
          setPanel(null)
          setPanelNode(null)
        }

        if (action === 'open_full' && node) {
          // 02–08：打开详情坞（自动载入当前图），不要新窗口/结构编辑器
          if (isStageImageDetailNode(node)) {
            openLayoutDetail(node)
            return
          }
          if (node.url) {
            window.open(assetUrl(node.url), '_blank', 'noopener,noreferrer')
          }
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

        if (
          (action === 'view_structure' || action === 'edit_structure') &&
          node
        ) {
          if (isStageImageDetailNode(node)) {
            openLayoutDetail(node)
          } else {
            void openStructureEditor(node)
          }
          return
        }

        if (action === 'generate_layout' && node?.jobId) {
          const approval = stage01ByJobRef.current[node.jobId]
          if (!approval) {
            setNotice('请先双击节点，在结构编辑器中确认结构后再生成布局')
            void openStructureEditor(node)
            return
          }
          extras = {
            ...extras,
            stage01Approval: toStage01Payload(approval),
          }
        }

        // 08：无标注文件时进入专注坞（对齐 01），不弹小窗、不立刻出骨架
        if (action === 'local_edit' && node && !extras?.markFile) {
          busyRef.current = false
          setBusy(false)
          await openLocalEditDock(node)
          return
        }

        const needsSkeleton = [
          'generate_layout',
          'generate_color_plan',
          'generate_axonometric',
          'generate_space_render',
          'generate_style_scheme',
          'generate_tone_scheme',
          'local_edit',
          'upload_floorplan_submit',
          'reanalyze',
        ].includes(action)
        // local_edit 仅在提交 markFile 后才需要骨架（上面已拦截无 mark 的打开坞路径）
        if (needsSkeleton) {
          busyActionRef.current = action
          skeletonGroupId = spawnSkeletons(action, node)
          const n = expectedSkeletonSlots(action, node).length
          setNotice(
            action === 'generate_layout'
              ? `正在生成 ${n} 个布局方案…右侧/下一列已显示占位框`
              : `正在${actionLabel(action)}…`,
          )
          // 等 React 提交骨架 state + 一帧绘制
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          })
        }

        const result = await executeCanvasAction({
          projectId,
          node,
          action,
          extras: {
            designPrompt,
            ...extras,
          },
          onJob: (job) => {
            // 进行中只绑定 jobId，**不要**在 SUCCEEDED 时立刻清骨架
            // （清早了会出现「闪一下就没了」，真实节点还在 loadGraph 路上）
            if (
              skeletonGroupId &&
              ['QUEUED', 'RUNNING'].includes(job.status)
            ) {
              bindSkeletonsToJob(skeletonGroupId, job)
            }
          },
          onNeedPanel: (next) => {
            if (skeletonGroupId) clearSkeletonGroup(skeletonGroupId)
            skeletonGroupId = null
            // local_edit 改走专注坞，不再用弹层
            if (next.kind === 'local_edit' && node) {
              void openLocalEditDock(node)
              return
            }
            setPanel(next)
            setPanelNode(node)
          },
        })

        if (!result.ok) {
          if (skeletonGroupId) clearSkeletonGroup(skeletonGroupId)
          if (result.needPanel?.kind === 'local_edit' && node) {
            await openLocalEditDock(node)
            return
          }
          setPanel(result.needPanel)
          setPanelNode(node)
          return
        }

        setNotice(result.message)
        setPanel(null)
        setPanelNode(null)
        // 先拉真实图谱，再拆占位，避免空白闪断
        await loadGraph({ fit: false })
        if (skeletonGroupId) clearSkeletonGroup(skeletonGroupId)
        // 再 apply 一次确保骨架已从 ref 去掉
        if (graphRef.current) applyGraph(graphRef.current, selectedId)

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
        if (skeletonGroupId) clearSkeletonGroup(skeletonGroupId)
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
        busyRef.current = false
        busyActionRef.current = null
        setBusy(false)
      }
    },
    [
      projectId,
      designPrompt,
      loadGraph,
      setNodes,
      openStructureEditor,
      openLayoutDetail,
      openLocalEditDock,
      isStageImageDetailNode,
      spawnSkeletons,
      bindSkeletonsToJob,
      clearSkeletonGroup,
      applyGraph,
      selectedId,
    ],
  )

  actionRef.current = (action, node) => {
    void runAction(action, node)
  }

  // 单击堆叠 → 展开；单击 02–08 方案图 → 详情坞；其它仅选中
  const onNodeClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const graphNode = (node.data as CanvasNodeData).graphNode
      setSelectedId(node.id)
      setContextMenu(null)
      if (graphNode.isStack && graphNode.stackKey) {
        expandStack(graphNode.stackKey)
        return
      }
      if (isStageImageDetailNode(graphNode) && !graphNode.isStack) {
        openLayoutDetail(graphNode)
      }
    },
    [isStageImageDetailNode, openLayoutDetail, expandStack],
  )

  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_event, node) => {
      const graphNode = (node.data as CanvasNodeData).graphNode
      setSelectedId(node.id)
      if (graphNode.isStack && graphNode.stackKey) {
        expandStack(graphNode.stackKey)
        return
      }
      // 02–08 优先：进图片详情，绝不进 01 结构编辑器
      if (isStageImageDetailNode(graphNode)) {
        openLayoutDetail(graphNode)
        return
      }
      if (isStage01Node(graphNode)) {
        void openStructureEditor(graphNode)
        return
      }
      if (graphNode.url) {
        window.open(assetUrl(graphNode.url), '_blank', 'noopener,noreferrer')
      }
    },
    [
      isStage01Node,
      isStageImageDetailNode,
      openStructureEditor,
      openLayoutDetail,
      expandStack,
    ],
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
        if (layoutDetailRef.current) {
          exitLayoutDetail()
          return
        }
        setContextMenu(null)
        setPanel(null)
        setSelectedId(null)
        return
      }
      if (
        structureEditorRef.current ||
        layoutDetailRef.current ||
        localEditRef.current
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
      className={`canvas-theme canvas-shell${inAnyFocus ? ' is-structure-focus' : ''}`}
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
      {/* 顶栏：图谱 / 01 结构 / 02 布局详情 共用 */}
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
          ) : inLocalEdit && localEdit ? (
            <>
              <button
                type="button"
                className="canvas-btn"
                onClick={() => exitLocalEdit({ notice: '已退出局部修改' })}
              >
                ← 返回图谱
              </button>
              <span className="canvas-pill">08 局部修改</span>
              <span className="canvas-pill">
                {(
                  localEdit.node.label ||
                  localEdit.node.variantId ||
                  '色调方案'
                ).replaceAll('_', ' ')}
              </span>
              <span className="canvas-pill canvas-muted-pill">红笔标注中</span>
            </>
          ) : inLayoutDetail && layoutDetailLive ? (
            <>
              <button
                type="button"
                className="canvas-btn"
                onClick={() => exitLayoutDetail()}
              >
                ← 返回图谱
              </button>
              <span className="canvas-pill">
                {stageLabel(normalizeStage(layoutDetailLive))} 详情
              </span>
              <span className="canvas-pill">
                {(
                  layoutDetailLive.label ||
                  layoutDetailLive.variantId ||
                  '方案'
                ).replaceAll('_', ' ')}
              </span>
              {layoutDetailLive.approved ? (
                <span className="canvas-pill" style={{ color: 'var(--canvas-success)' }}>
                  ✓ 已批准
                </span>
              ) : (
                <span className="canvas-pill canvas-muted-pill">待批准</span>
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
        {!inAnyFocus ? (
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
              完成并返回
            </button>
          </div>
        )}
      </div>

      <div className="canvas-body">
        {/* 图谱常驻挂载，focus 时仅隐藏，保留视口 */}
        <div
          className={`canvas-graph-pane${inAnyFocus ? ' is-parked' : ''}`}
          aria-hidden={inAnyFocus}
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
            minZoom={0.05}
            maxZoom={16}
            zoomOnDoubleClick={false}
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
              <button
                type="button"
                className="canvas-btn"
                title="缩小"
                onClick={() => zoomOut({ duration: 120 })}
              >
                −
              </button>
              <button
                type="button"
                className="canvas-btn"
                title="适应画布（单击）· 滚轮可放大到 1600%"
                onClick={() => fitView({ padding: 0.18 })}
              >
                {zoomPercent(zoom)}%
              </button>
              <button
                type="button"
                className="canvas-btn"
                title="放大（最高 1600%）"
                onClick={() => zoomIn({ duration: 120 })}
              >
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
                  右键空白处上传户型 · 单击 02–08 打开详情 · 双击 01 编辑结构
                </span>
              )}
              {busy ? <span className="canvas-pill">执行中…</span> : null}
            </div>
          </div>

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

        {/* 02–07 方案详情坞：自动载入当前方案图 */}
        {layoutDetailLive && !localEdit ? (
          <LayoutDetailDock
            node={layoutDetailLive}
            busy={busy}
            onBack={() => exitLayoutDetail()}
            onApprove={() => {
              void runAction('approve', layoutDetailLive)
            }}
            primaryActions={(() => {
              const target = layoutDetailLive
              const stage = normalizeStage(target)
              const runDerived = (action: string) => {
                void (async () => {
                  // 先尽量批准，再派生（busy 用 ref，可连续 await）
                  if (!target.approved) {
                    await runAction('approve', target)
                  }
                  // local_edit 进入专注坞；其它派生先回图谱再跑
                  if (action === 'local_edit') {
                    setLayoutDetail(null)
                    await runAction(action, target)
                    return
                  }
                  exitLayoutDetail({ focusNodeId: target.id })
                  await runAction(action, target)
                })()
              }
              return primaryDeriveActionsForStage(stage).map((item) => ({
                ...item,
                key: item.action,
                disabled: !target.assetId,
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
                    void runAction(item.action, contextMenu.node)
                    setContextMenu(null)
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
