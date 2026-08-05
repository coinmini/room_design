/**
 * 将服务端图谱 + 骨架占位 合并为 React Flow 可用的布局与边。
 * 纯函数：不含 setState，便于单测。
 */

import type { ActionContext } from './canRunAction'
import {
  layoutGraphByStage,
  resolveFlowEdges,
  type LaidOutNode,
} from './layoutMath'
import type { SkeletonSlot } from './skeletonMath'
import {
  applyImageStacks,
  remapEdgesForStacks,
  stackEndpointMap,
} from './stackMath'
import type { CanvasGraph, CanvasGraphNode } from './types'
import { normalizeStage } from './types'

export type BuiltFlowEdge = {
  id: string
  source: string
  target: string
  skeleton?: boolean
}

export type BuiltFlowNode = LaidOutNode & {
  actionCtx: ActionContext
}

export function skeletonNodesFromSlots(
  skeletons: SkeletonSlot[],
): CanvasGraphNode[] {
  return skeletons.map((item) => ({
    id: `skeleton:${item.id}`,
    jobId: item.jobId,
    variantId: item.id,
    label: item.label,
    title: item.label,
    url: item.url || undefined,
    thumbnailUrl: item.url || undefined,
    isSkeleton: true,
    jobStatus: item.jobStatus || undefined,
    progressSucceeded: item.succeededCount ?? undefined,
    progressTotal: item.totalCount ?? undefined,
    errorMessage: item.errorMessage || undefined,
    workflowStage: item.workflowStage,
    parentAssetId: item.parentAssetId,
    moduleKey:
      item.workflowStage === 'layout'
        ? 'layout'
        : item.workflowStage === 'floorplan'
          ? 'floorplan'
          : 'ai_workflow',
  }))
}

export function parentAssetIdsFromGraph(body: CanvasGraph): Set<string> {
  const parentIds = new Set<string>()
  for (const edge of body.edges) {
    if (edge.sourceAssetId) parentIds.add(edge.sourceAssetId)
  }
  return parentIds
}

export function buildCanvasFlow(opts: {
  body: CanvasGraph
  skeletons: SkeletonSlot[]
  expandedStacks: Set<string>
  stage01ConfirmedJobs: Record<string, unknown>
}): {
  parentIds: Set<string>
  displayNodes: BuiltFlowNode[]
  edges: BuiltFlowEdge[]
} {
  const { body, skeletons, expandedStacks, stage01ConfirmedJobs } = opts
  const parentIds = parentAssetIdsFromGraph(body)
  const skeletonNodes = skeletonNodesFromSlots(skeletons)
  const withSkeletons: CanvasGraphNode[] = [...body.nodes, ...skeletonNodes]
  const displayRaw = applyImageStacks(withSkeletons, expandedStacks)
  const laid = layoutGraphByStage(displayRaw)
  const endpointMap = stackEndpointMap(withSkeletons, displayRaw)
  const flowEdges = remapEdgesForStacks(
    resolveFlowEdges(body.nodes, body.edges),
    endpointMap,
  )

  const parentIdSet = new Set(body.nodes.map((n) => n.id))
  const displayIdSet = new Set(displayRaw.map((n) => n.id))
  const skeletonEdges = skeletons
    .filter((s) => s.parentNodeId && parentIdSet.has(s.parentNodeId))
    .map((s) => {
      const source = endpointMap.get(s.parentNodeId!) ?? s.parentNodeId!
      const target = `skeleton:${s.id}`
      return {
        id: `sk-edge:${s.id}`,
        source,
        target: displayIdSet.has(target)
          ? target
          : endpointMap.get(target) ?? target,
        skeleton: true as const,
      }
    })
    .filter((e) => displayIdSet.has(e.source) && displayIdSet.has(e.target))

  const displayNodes: BuiltFlowNode[] = laid.map((item) => {
    const stage = normalizeStage(item)
    const actionCtx: ActionContext = {
      hasDownstream: item.assetId ? parentIds.has(item.assetId) : false,
      isApprovedVariant: Boolean(item.approved),
      stage01Confirmed:
        stage === 'floorplan' && item.jobId
          ? Boolean(stage01ConfirmedJobs[item.jobId])
          : undefined,
    }
    return { ...item, actionCtx }
  })

  return {
    parentIds,
    displayNodes,
    edges: [
      ...flowEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
      })),
      ...skeletonEdges,
    ],
  }
}
