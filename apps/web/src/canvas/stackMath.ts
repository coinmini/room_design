/**
 * 多图堆叠：同一次生成 / 同一 asset（或 job）的多 variant
 * 默认叠成一张，点击展开；≥2 张即堆叠。
 */

import type { CanvasGraphNode } from './types'
import { isVariantApproved, normalizeStage, stageLabel } from './types'

/**
 * 会一次出多图的阶段：同 asset / job 下多 variant 默认堆叠。
 * 01 户型通常单结果；08 局部通常单结果，不在此列。
 */
export const STACKABLE_STAGES = new Set([
  'layout',
  'color_plan',
  'axonometric',
  'space_render',
  'style_scheme',
  'tone_scheme',
])

/** ≥ 此数量才折叠成堆（单张不叠） */
export const STACK_MIN_COUNT = 2

export function stackKeyFor(node: CanvasGraphNode): string | null {
  if (node.isStack) return node.stackKey ?? node.id
  const stage = normalizeStage(node)
  if (!STACKABLE_STAGES.has(stage)) return null

  // 生成中占位：同父同阶段的多骨架也叠成一张
  if (node.isSkeleton) {
    if (node.parentAssetId) {
      return `stack:skel:asset:${node.parentAssetId}:${stage}`
    }
    if (node.jobId) {
      return `stack:skel:job:${node.jobId}:${stage}`
    }
    // 无父信息时按 stage+job 前缀弱分组（骨架 id 形如 gen-xxx-1）
    const group = node.variantId?.replace(/-\d+$/, '') || node.id
    return `stack:skel:loose:${stage}:${group}`
  }

  if (node.assetId) return `stack:asset:${node.assetId}:${stage}`
  if (node.jobId) return `stack:job:${node.jobId}:${stage}`
  return null
}

function stackTitleFor(stage: string, count: number, cover: CanvasGraphNode): {
  label: string
  title: string
} {
  const stageName = stageLabel(stage).replace(/^\d+\s*/, '') || stage
  if (cover.isSkeleton) {
    return {
      label: `${stageName} · 生成中 ${count} 张`,
      title: cover.title || `${stageName}生成中`,
    }
  }
  return {
    label: `${stageName} · ${count} 张`,
    title: cover.title || `${stageName}方案`,
  }
}

/**
 * 将可堆叠节点折叠/展开为展示节点列表。
 * - 未展开且 ≥2 张 → 合成 isStack 代表节点
 * - 已展开 → 保留全部成员并打上 stackExpanded 标记
 */
export function applyImageStacks(
  nodes: CanvasGraphNode[],
  expanded: ReadonlySet<string>,
): CanvasGraphNode[] {
  const groups = new Map<string, CanvasGraphNode[]>()
  const passthrough: CanvasGraphNode[] = []

  for (const node of nodes) {
    const key = stackKeyFor(node)
    if (!key) {
      passthrough.push(node)
      continue
    }
    const list = groups.get(key) ?? []
    list.push(node)
    groups.set(key, list)
  }

  const result: CanvasGraphNode[] = [...passthrough]

  for (const [key, items] of groups) {
    // 稳定顺序：批准优先，再按 label / variantId
    const ordered = [...items].sort((a, b) => {
      const ap = isVariantApproved(a) ? 0 : 1
      const bp = isVariantApproved(b) ? 0 : 1
      if (ap !== bp) return ap - bp
      return (a.label || a.variantId).localeCompare(b.label || b.variantId, 'zh')
    })

    if (ordered.length < STACK_MIN_COUNT) {
      result.push(...ordered)
      continue
    }

    const stage = normalizeStage(ordered[0])

    if (expanded.has(key)) {
      for (let i = 0; i < ordered.length; i += 1) {
        const item = ordered[i]
        result.push({
          ...item,
          stackKey: key,
          stackCount: ordered.length,
          stackIndex: i,
          stackExpanded: true,
        })
      }
      continue
    }

    const cover = ordered[0]
    const { label, title } = stackTitleFor(stage, ordered.length, cover)
    result.push({
      ...cover,
      id: key,
      variantId: 'stack',
      isStack: true,
      stackKey: key,
      stackCount: ordered.length,
      stackItems: ordered,
      label,
      title,
      // 堆叠本身不作为单一批准态；成员各自保留 approved
      approved: false,
      approvalStatus: ordered.some((n) => isVariantApproved(n))
        ? 'partial'
        : null,
    })
  }

  return result
}

/**
 * 边的端点映射：折叠时隐藏成员 id → 堆叠 id。
 */
export function stackEndpointMap(
  originalNodes: CanvasGraphNode[],
  displayNodes: CanvasGraphNode[],
): Map<string, string> {
  const map = new Map<string, string>()

  for (const n of originalNodes) {
    map.set(n.id, n.id)
  }
  for (const n of displayNodes) {
    map.set(n.id, n.id)
  }

  for (const n of displayNodes) {
    if (n.isStack && n.stackItems?.length) {
      for (const item of n.stackItems) {
        map.set(item.id, n.id)
      }
    }
  }

  return map
}

export function remapEdgesForStacks(
  edges: Array<{ id: string; source: string; target: string }>,
  endpointMap: Map<string, string>,
): Array<{ id: string; source: string; target: string }> {
  const seen = new Set<string>()
  const result: Array<{ id: string; source: string; target: string }> = []
  for (const edge of edges) {
    const source = endpointMap.get(edge.source) ?? edge.source
    const target = endpointMap.get(edge.target) ?? edge.target
    if (source === target) continue
    const pairKey = `${source}=>${target}`
    if (seen.has(pairKey)) continue
    seen.add(pairKey)
    result.push({
      id: `${edge.id}:${pairKey}`,
      source,
      target,
    })
  }
  return result
}
