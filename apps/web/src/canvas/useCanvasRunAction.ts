/**
 * 画布节点动作：派生生成、骨架、详情坞、重试/丢弃。
 */

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Node } from '@xyflow/react'
import { assetUrl } from '../api'
import type { FloorplanStage01Approval } from '../FloorplanModule'
import {
  executeCanvasAction,
  type Stage01ApprovalPayload,
  type StagePanelRequest,
} from '../workflow/canvasRunner'
import { removeActiveCanvasJob } from './activeJobs'
import { actionLabel } from './actionLabels'
import type { CanvasNodeData } from './CanvasNodeCard'
import type { GenerateDialogMode } from './GenerateLayoutDialog'
import { isStage01Node, isStageImageDetailNode } from './nodeStage'
import { expectedSkeletonSlots } from './skeletonMath'
import type { SkeletonSlot } from './skeletonMath'
import {
  dialogModeForAction,
  isSpawnDialogAction,
  nodeHasApprovedSpawnSource,
  primarySpawnForNode,
  resolveSpawnSourceNode,
} from './spawnDerive'
import type { CanvasGraph, CanvasGraphNode } from './types'
import { isVariantApproved } from './types'

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

export type RunActionExtras = NonNullable<
  Parameters<typeof executeCanvasAction>[0]['extras']
>

export function useCanvasRunAction(opts: {
  projectId: string
  designPrompt: string
  selectedId: string | null
  graphRef: MutableRefObject<CanvasGraph | null>
  skeletonSlotsRef: MutableRefObject<SkeletonSlot[]>
  stage01ByJobRef: MutableRefObject<Record<string, FloorplanStage01Approval>>
  busyRef: MutableRefObject<boolean>
  busyActionRef: MutableRefObject<string | null>
  setBusy: (v: boolean) => void
  setNotice: (msg: string) => void
  setContextMenu: (v: null) => void
  setPanel: Dispatch<SetStateAction<StagePanelRequest | null>>
  setPanelNode: Dispatch<SetStateAction<CanvasGraphNode | null>>
  setSelectedId: (id: string | null) => void
  setGenerateDialog: Dispatch<
    SetStateAction<{ node: CanvasGraphNode; mode: GenerateDialogMode } | null>
  >
  setSpawnMenu: (v: null) => void
  setStructureEditor: Dispatch<
    SetStateAction<{ jobId: string; node: CanvasGraphNode } | null>
  >
  setNodes: Dispatch<SetStateAction<Node[]>>
  applyGraph: (body: CanvasGraph, selected: string | null) => void
  loadGraph: (opts?: { fit?: boolean }) => Promise<void>
  openLayoutDetail: (node: CanvasGraphNode) => void
  openStructureEditor: (node: CanvasGraphNode) => void | Promise<void>
  openLocalEditDock: (node: CanvasGraphNode) => Promise<void>
  spawnSkeletons: (
    action: string,
    parent: CanvasGraphNode | null,
    extras?: {
      selectedSpaceIds?: string[]
      selectedStyleVariants?: string[]
      selectedToneVariants?: string[]
      selectedAxonometricVariants?: string[]
    },
  ) => string
  bindSkeletonsToJob: (groupId: string, job: import('../api').Job) => void
  clearSkeletonGroup: (groupId: string) => void
  resetSkeletonsForRetry: (groupId: string) => void
}) {
  const {
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
    setSpawnMenu,
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
  } = opts

  return useCallback(
    async (
      action: string,
      node: CanvasGraphNode | null,
      extras?: RunActionExtras,
    ) => {
      setContextMenu(null)
      setNotice('')

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
        if (
          (action === 'generate_space_render' && extras?.selectedSpaceIds) ||
          (action === 'generate_style_scheme' &&
            extras?.selectedStyleVariants) ||
          (action === 'generate_tone_scheme' && extras?.selectedToneVariants) ||
          (action === 'generate_axonometric' &&
            extras?.selectedAxonometricVariants) ||
          (action === 'local_edit' && extras?.markFile) ||
          (action === 'upload_floorplan_submit' && extras?.file)
        ) {
          setPanel(null)
          setPanelNode(null)
        }

        if (action === 'open_full' && node) {
          if (isStageImageDetailNode(node) || isStage01Node(node)) {
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
          action === 'delete' &&
          node?.isSkeleton &&
          (node.jobStatus === 'FAILED' || node.jobStatus === 'CANCELED')
        ) {
          const slot = skeletonSlotsRef.current.find(
            (s) => s.id === node.variantId || `skeleton:${s.id}` === node.id,
          )
          if (slot) {
            clearSkeletonGroup(slot.groupId)
            if (slot.jobId) {
              removeActiveCanvasJob(projectId, {
                jobId: slot.jobId,
                groupId: slot.groupId,
              })
            }
            if (graphRef.current) applyGraph(graphRef.current, selectedId)
            setNotice('已丢弃失败/取消的生成占位')
          }
          busyRef.current = false
          setBusy(false)
          return
        }

        if (
          action === 'retry' &&
          node?.isSkeleton &&
          node.jobStatus === 'FAILED' &&
          node.jobId
        ) {
          const slot = skeletonSlotsRef.current.find(
            (s) => s.id === node.variantId || `skeleton:${s.id}` === node.id,
          )
          const groupId = slot?.groupId ?? null
          skeletonGroupId = groupId
          setNotice('正在重试生成…')
          if (groupId) {
            resetSkeletonsForRetry(groupId)
            if (graphRef.current) applyGraph(graphRef.current, selectedId)
          }
          try {
            const result = await executeCanvasAction({
              projectId,
              node,
              action: 'retry',
              onJob: (job) => {
                if (groupId) bindSkeletonsToJob(groupId, job)
              },
            })
            if (result.ok) {
              await loadGraph({ fit: false })
              if (groupId) clearSkeletonGroup(groupId)
              setNotice(result.message || '重试完成')
            }
          } catch (value) {
            setNotice(value instanceof Error ? value.message : '重试失败')
          } finally {
            busyRef.current = false
            setBusy(false)
          }
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

        const dialogConfirmed = Boolean(
          extras?.spawnDialogConfirmed ||
            extras?.layoutDialogConfirmed ||
            extras?.colorPlanDialogConfirmed,
        )

        if (
          action === 'generate_space_render' &&
          node &&
          !extras?.selectedSpaceIds?.length
        ) {
          busyRef.current = false
          setBusy(false)
          if (!isVariantApproved(node) && !nodeHasApprovedSpawnSource(node)) {
            setNotice('请先批准当前方案后再生成分空间')
            return
          }
          const source = resolveSpawnSourceNode(node) ?? node
          setSelectedId(node.id)
          setGenerateDialog(null)
          setSpawnMenu(null)
          try {
            const panelResult = await executeCanvasAction({
              projectId,
              node: source,
              action: 'generate_space_render',
              extras: { designPrompt, ...extras },
            })
            if (!panelResult.ok && panelResult.needPanel) {
              setPanel(panelResult.needPanel)
              setPanelNode(source)
              setNotice('勾选要生成的房间，可多选')
              return
            }
          } catch (value) {
            setNotice(
              value instanceof Error ? value.message : '无法加载房间列表',
            )
          }
          return
        }

        if (
          action === 'generate_style_scheme' &&
          node &&
          !extras?.selectedStyleVariants?.length
        ) {
          busyRef.current = false
          setBusy(false)
          if (!isVariantApproved(node) && !nodeHasApprovedSpawnSource(node)) {
            setNotice('请先批准当前方案后再生成风格')
            return
          }
          const source = resolveSpawnSourceNode(node) ?? node
          setSelectedId(node.id)
          setGenerateDialog(null)
          setSpawnMenu(null)
          try {
            const panelResult = await executeCanvasAction({
              projectId,
              node: source,
              action: 'generate_style_scheme',
              extras: { designPrompt, ...extras },
            })
            if (!panelResult.ok && panelResult.needPanel) {
              setPanel(panelResult.needPanel)
              setPanelNode(source)
              setNotice('勾选要生成的风格方案，可多选')
              return
            }
          } catch (value) {
            setNotice(
              value instanceof Error ? value.message : '无法打开风格选择',
            )
          }
          return
        }

        if (
          action === 'generate_tone_scheme' &&
          node &&
          !extras?.selectedToneVariants?.length
        ) {
          busyRef.current = false
          setBusy(false)
          if (!isVariantApproved(node) && !nodeHasApprovedSpawnSource(node)) {
            setNotice('请先批准当前方案后再生成色调')
            return
          }
          const source = resolveSpawnSourceNode(node) ?? node
          setSelectedId(node.id)
          setGenerateDialog(null)
          setSpawnMenu(null)
          try {
            const panelResult = await executeCanvasAction({
              projectId,
              node: source,
              action: 'generate_tone_scheme',
              extras: { designPrompt, ...extras },
            })
            if (!panelResult.ok && panelResult.needPanel) {
              setPanel(panelResult.needPanel)
              setPanelNode(source)
              setNotice('勾选要生成的色调方案，可多选')
              return
            }
          } catch (value) {
            setNotice(
              value instanceof Error ? value.message : '无法打开色调选择',
            )
          }
          return
        }

        if (
          action === 'generate_axonometric' &&
          node &&
          !extras?.selectedAxonometricVariants?.length
        ) {
          busyRef.current = false
          setBusy(false)
          if (!isVariantApproved(node) && !nodeHasApprovedSpawnSource(node)) {
            setNotice('请先批准当前方案后再生成轴侧')
            return
          }
          const source = resolveSpawnSourceNode(node) ?? node
          setSelectedId(node.id)
          setGenerateDialog(null)
          setSpawnMenu(null)
          try {
            const panelResult = await executeCanvasAction({
              projectId,
              node: source,
              action: 'generate_axonometric',
              extras: { designPrompt, ...extras },
            })
            if (!panelResult.ok && panelResult.needPanel) {
              setPanel(panelResult.needPanel)
              setPanelNode(source)
              setNotice('勾选要生成的轴侧方案，可多选')
              return
            }
          } catch (value) {
            setNotice(
              value instanceof Error ? value.message : '无法打开轴侧选择',
            )
          }
          return
        }

        if (
          isSpawnDialogAction(action) &&
          action !== 'generate_space_render' &&
          action !== 'generate_style_scheme' &&
          action !== 'generate_tone_scheme' &&
          action !== 'generate_axonometric' &&
          node &&
          !dialogConfirmed
        ) {
          busyRef.current = false
          setBusy(false)
          if (action === 'generate_layout') {
            if (!node.jobId || !stage01ByJobRef.current[node.jobId]) {
              setNotice('请先在结构编辑器中确认结构后再生成布局')
              void openStructureEditor(node)
              return
            }
          } else if (
            !isVariantApproved(node) &&
            !nodeHasApprovedSpawnSource(node)
          ) {
            setNotice('请先批准当前方案后再派生下游')
            return
          }
          const mode = dialogModeForAction(action)
          if (!mode) {
            setNotice('当前动作不支持生成对话框')
            return
          }
          const source = resolveSpawnSourceNode(node) ?? node
          setGenerateDialog({ node: source, mode })
          const spawn = primarySpawnForNode(source)
          setNotice(spawn?.notice ?? '填写意向后点击箭头生成')
          return
        }

        if (action === 'generate_layout' && node?.jobId) {
          const approval = stage01ByJobRef.current[node.jobId]
          if (!approval) {
            setNotice('请先在结构编辑器中确认结构后再生成布局')
            void openStructureEditor(node)
            return
          }
          extras = {
            ...extras,
            stage01Approval: toStage01Payload(approval),
          }
        }

        if (action === 'local_edit' && node && !extras?.markFile) {
          busyRef.current = false
          setBusy(false)
          await openLocalEditDock(node)
          return
        }

        const needsSkeleton =
          [
            'generate_layout',
            'generate_color_plan',
            'generate_axonometric',
            'generate_space_render',
            'generate_style_scheme',
            'generate_tone_scheme',
            'local_edit',
            'upload_floorplan_submit',
            'reanalyze',
          ].includes(action) &&
          !(
            action === 'generate_space_render' &&
            !extras?.selectedSpaceIds?.length
          ) &&
          !(
            action === 'generate_style_scheme' &&
            !extras?.selectedStyleVariants?.length
          ) &&
          !(
            action === 'generate_tone_scheme' &&
            !extras?.selectedToneVariants?.length
          ) &&
          !(
            action === 'generate_axonometric' &&
            !extras?.selectedAxonometricVariants?.length
          ) &&
          !(action === 'local_edit' && !extras?.markFile)
        if (needsSkeleton) {
          busyActionRef.current = action
          skeletonGroupId = spawnSkeletons(action, node, {
            selectedSpaceIds: extras?.selectedSpaceIds,
            selectedStyleVariants: extras?.selectedStyleVariants,
            selectedToneVariants: extras?.selectedToneVariants,
            selectedAxonometricVariants: extras?.selectedAxonometricVariants,
          })
          const n = expectedSkeletonSlots(action, node, {
            selectedSpaceIds: extras?.selectedSpaceIds,
            selectedStyleVariants: extras?.selectedStyleVariants,
            selectedToneVariants: extras?.selectedToneVariants,
            selectedAxonometricVariants: extras?.selectedAxonometricVariants,
          }).length
          setNotice(
            action === 'generate_layout'
              ? `正在生成 ${n} 个布局方案…右侧/下一列已显示占位框`
              : action === 'generate_space_render'
                ? `正在生成 ${n} 个分空间…`
                : action === 'generate_style_scheme'
                  ? `正在生成 ${n} 种风格方案…`
                  : action === 'generate_tone_scheme'
                    ? `正在生成 ${n} 种色调方案…`
                    : action === 'generate_axonometric'
                      ? `正在生成 ${n} 种轴侧…`
                      : `正在${actionLabel(action)}…`,
          )
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
            if (!skeletonGroupId) return
            if (
              ['QUEUED', 'RUNNING', 'FAILED', 'CANCELED'].includes(job.status)
            ) {
              bindSkeletonsToJob(skeletonGroupId, job)
              const jobResult = (job.result || {}) as Record<string, unknown>
              const total =
                skeletonSlotsRef.current.filter(
                  (s) => s.groupId === skeletonGroupId,
                ).length || 1
              const done =
                typeof jobResult.succeededCount === 'number'
                  ? jobResult.succeededCount
                  : Array.isArray(jobResult.outputs)
                    ? (jobResult.outputs as unknown[]).filter((o) => {
                        const rec = o as Record<string, unknown>
                        return (
                          rec &&
                          (rec.status === 'succeeded' ||
                            typeof rec.url === 'string')
                        )
                      }).length
                    : 0
              if (job.status === 'RUNNING' || job.status === 'QUEUED') {
                setNotice(
                  done > 0
                    ? `生成中 ${done}/${total}…已出图可先预览`
                    : `生成中 0/${total}…`,
                )
              } else if (job.status === 'FAILED') {
                setNotice(
                  job.errorMessage
                    ? `生成失败：${job.errorMessage}`
                    : `生成失败（${done}/${total} 已出图可保留）`,
                )
              } else if (job.status === 'CANCELED') {
                setNotice(`已取消（${done}/${total} 已出图）`)
              }
            }
          },
          onNeedPanel: (next) => {
            if (skeletonGroupId) clearSkeletonGroup(skeletonGroupId)
            skeletonGroupId = null
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
        await loadGraph({ fit: false })
        if (skeletonGroupId) {
          clearSkeletonGroup(skeletonGroupId)
          if (result.job?.id) {
            removeActiveCanvasJob(projectId, {
              jobId: result.job.id,
              groupId: skeletonGroupId,
            })
          }
        }
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
          setNotice('识别完成：单击节点预览，再点大图进入结构编辑并确认')
        }
      } catch (value) {
        if (skeletonGroupId) clearSkeletonGroup(skeletonGroupId)
        const message = value instanceof Error ? value.message : '操作失败'
        setNotice(message)
        if (
          message.includes('结构编辑器') ||
          message.includes('确认结构')
        ) {
          if (node) void openStructureEditor(node)
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
      setSpawnMenu,
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
    ],
  )
}
