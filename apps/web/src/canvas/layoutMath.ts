import type { CanvasGraphEdge, CanvasGraphNode } from './types'
import { STAGE_COLUMNS, normalizeStage } from './types'

export type LaidOutNode = CanvasGraphNode & {
  x: number
  y: number
  w: number
  h: number
}

const NODE_W = 220
const NODE_H = 248
const COL_GAP = 88
const ROW_GAP = 28
const ORIGIN_X = 48
const ORIGIN_Y = 48

/**
 * 按 workflowStage 分列、同列变体纵向排布。
 * 纯函数，便于 W5 单测。
 */
export function layoutGraphByStage(nodes: CanvasGraphNode[]): LaidOutNode[] {
  const columns = new Map<string, CanvasGraphNode[]>()
  for (const col of STAGE_COLUMNS) columns.set(col.stage, [])

  for (const node of nodes) {
    const stage = normalizeStage(node)
    const bucket = columns.get(stage) ?? columns.get('other')!
    bucket.push(node)
  }

  const laid: LaidOutNode[] = []
  STAGE_COLUMNS.forEach((col, colIndex) => {
    const bucket = columns.get(col.stage) ?? []
    bucket.forEach((node, rowIndex) => {
      laid.push({
        ...node,
        x: ORIGIN_X + colIndex * (NODE_W + COL_GAP),
        y: ORIGIN_Y + rowIndex * (NODE_H + ROW_GAP),
        w: NODE_W,
        h: NODE_H,
      })
    })
  })
  return laid
}

/** 将图谱边映射到 xyflow 边：source/target 用节点 id（asset:variant）。 */
export function resolveFlowEdges(
  nodes: CanvasGraphNode[],
  edges: CanvasGraphEdge[],
): Array<{ id: string; source: string; target: string }> {
  const byAsset = new Map<string, CanvasGraphNode[]>()
  for (const node of nodes) {
    if (!node.assetId) continue
    const list = byAsset.get(node.assetId) ?? []
    list.push(node)
    byAsset.set(node.assetId, list)
  }

  const result: Array<{ id: string; source: string; target: string }> = []
  for (const edge of edges) {
    const sources = byAsset.get(edge.sourceAssetId) ?? []
    const targets = edge.targetAssetId
      ? (byAsset.get(edge.targetAssetId) ?? [])
      : nodes.filter(
          (n) => n.isTemporary && n.jobId && edge.targetJobId === n.jobId,
        )

    if (!sources.length || !targets.length) continue

    let sourceNode =
      (edge.sourceVariantId
        ? sources.find((n) => n.variantId === edge.sourceVariantId)
        : undefined) ??
      sources.find((n) => n.approved) ??
      sources[0]

    for (const targetNode of targets) {
      result.push({
        id: `${edge.id}:${targetNode.id}`,
        source: sourceNode.id,
        target: targetNode.id,
      })
    }
  }
  return result
}

/** 节点身份：已归档资产用 asset:variant；进行中 job 用 job:variant。 */
export function nodeIdentity(parts: {
  assetId?: string | null
  jobId?: string | null
  variantId: string
  isTemporary?: boolean
}): string {
  if (parts.isTemporary && parts.jobId) {
    return `partial:${parts.jobId}:${parts.variantId}`
  }
  if (parts.assetId) return `${parts.assetId}:${parts.variantId}`
  if (parts.jobId) return `${parts.jobId}:${parts.variantId}`
  return `orphan:${parts.variantId}`
}

/** job 成功归档后，将临时/job 身份交接为 asset 身份。 */
export function handoffJobToAsset(
  previousId: string,
  assetId: string,
  variantId: string,
): string {
  void previousId
  return `${assetId}:${variantId}`
}

/** 视口：屏幕坐标 → 画布坐标 */
export function screenToCanvas(
  screenX: number,
  screenY: number,
  viewport: { x: number; y: number; zoom: number },
): { x: number; y: number } {
  return {
    x: (screenX - viewport.x) / viewport.zoom,
    y: (screenY - viewport.y) / viewport.zoom,
  }
}

export function canvasToScreen(
  canvasX: number,
  canvasY: number,
  viewport: { x: number; y: number; zoom: number },
): { x: number; y: number } {
  return {
    x: canvasX * viewport.zoom + viewport.x,
    y: canvasY * viewport.zoom + viewport.y,
  }
}

export function zoomPercent(zoom: number): number {
  return Math.round(zoom * 100)
}
