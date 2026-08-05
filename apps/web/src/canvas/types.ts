export type WorkflowStage =
  | 'annotation'
  | 'layout'
  | 'color_plan'
  | 'axonometric'
  | 'space_render'
  | 'style_scheme'
  | 'tone_scheme'
  | 'local_edit'
  | 'style'
  | 'tone'
  | string

export type CanvasGraphNode = {
  id: string
  assetId?: string | null
  jobId?: string | null
  variantId: string
  url?: string | null
  thumbnailUrl?: string | null
  label?: string
  title?: string
  status?: string
  approved?: boolean
  approvedVersionId?: string | null
  assetType?: string
  generationMode?: string
  moduleKey?: string | null
  workflowStage?: WorkflowStage | null
  approvalStatus?: string | null
  parentAssetId?: string | null
  parentVariantId?: string | null
  createdAt?: string | null
  isTemporary?: boolean
  jobStatus?: string | null
  isSkeleton?: boolean
  /** 生成进度：已完成 / 总数（骨架节点） */
  progressSucceeded?: number | null
  progressTotal?: number | null
  errorMessage?: string | null
  /** 分空间等多图堆叠：折叠态代表节点 */
  isStack?: boolean
  /** 堆叠分组 key（asset / job） */
  stackKey?: string
  /** 堆叠内张数 */
  stackCount?: number
  /** 展开态：同组序号 0..n-1 */
  stackIndex?: number
  /** 展开态标记 */
  stackExpanded?: boolean
  /** 折叠态：组内全部成员（用于预览层叠） */
  stackItems?: CanvasGraphNode[]
}

/**
 * 是否为「本 variant 已批准」。
 * 优先用布尔字段 approved；勿单独信资产级 approvalStatus，
 * 否则同资产其它未批 variant 会误显示已批准。
 */
export function isVariantApproved(
  node: Pick<CanvasGraphNode, 'approved' | 'approvalStatus'>,
): boolean {
  if (typeof node.approved === 'boolean') return node.approved
  return node.approvalStatus === 'approved'
}

export type CanvasGraphEdge = {
  id: string
  sourceAssetId: string
  sourceVariantId?: string | null
  targetAssetId?: string
  targetJobId?: string
}

export type CanvasGraph = {
  projectId: string
  assetCount: number
  partialJobCount?: number
  nodeCount: number
  nodes: CanvasGraphNode[]
  edges: CanvasGraphEdge[]
  /** 图谱端点对无 project 资产做回退时为 true */
  includedOrphanAssets?: boolean
}

export type CanvasAction =
  | 'approve'
  | 'unapprove'
  | 'set_baseline'
  | 'generate_layout'
  | 'generate_color_plan'
  | 'generate_axonometric'
  | 'generate_space_render'
  | 'generate_style_scheme'
  | 'generate_tone_scheme'
  | 'local_edit'
  | 'retry'
  | 'open_full'
  | 'download'
  | 'copy_node'
  | 'duplicate'
  | 'delete'
  | 'rebind_baseline'
  | 'view_structure'
  | 'reanalyze'

export type ActionAvailability = {
  action: CanvasAction
  enabled: boolean
  reason?: string
  label: string
  shortcut?: string
}

export const STAGE_COLUMNS: Array<{ stage: string; label: string }> = [
  { stage: 'floorplan', label: '01 户型' },
  { stage: 'layout', label: '02 布局' },
  { stage: 'color_plan', label: '03 彩平' },
  { stage: 'axonometric', label: '04 轴侧' },
  { stage: 'space_render', label: '05 分空间' },
  { stage: 'style_scheme', label: '06 风格' },
  { stage: 'tone_scheme', label: '07 色调' },
  { stage: 'local_edit', label: '08 局部' },
  { stage: 'other', label: '其他' },
]

export function normalizeStage(node: CanvasGraphNode): string {
  // assetType 优先纠偏存量错误 moduleKey（LAYOUT_AI 曾继承 floorplan）
  if (
    node.assetType === 'layout_plan' ||
    node.moduleKey === 'layout' ||
    node.title?.includes('平面布局')
  ) {
    return 'layout'
  }
  if (
    node.assetType === 'ai_color_plan' ||
    node.assetType === 'color_plan' ||
    node.moduleKey === 'color_plan' ||
    node.title?.includes('彩平')
  ) {
    return 'color_plan'
  }
  if (
    node.assetType === 'ai_axonometric' ||
    node.moduleKey === 'axonometric' ||
    node.title?.includes('轴侧') ||
    node.title?.includes('轴测')
  ) {
    return 'axonometric'
  }
  if (
    node.assetType === 'ai_space_render' ||
    node.moduleKey === 'space_render' ||
    node.title?.includes('分空间') ||
    node.title?.includes('空间效果')
  ) {
    return 'space_render'
  }
  if (
    node.assetType === 'ai_style_scheme' ||
    node.moduleKey === 'style_scheme' ||
    node.title?.includes('风格方案')
  ) {
    return 'style_scheme'
  }
  if (
    node.assetType === 'ai_tone_scheme' ||
    node.moduleKey === 'tone_scheme' ||
    node.title?.includes('色调方案')
  ) {
    return 'tone_scheme'
  }
  if (
    node.assetType === 'ai_local_edit' ||
    node.moduleKey === 'local_edit' ||
    node.title?.includes('局部修改')
  ) {
    return 'local_edit'
  }
  if (
    node.assetType === 'floorplan_analysis' ||
    node.moduleKey === 'floorplan'
  ) {
    return 'floorplan'
  }
  if (node.workflowStage) {
    if (node.workflowStage === 'style') return 'style_scheme'
    if (node.workflowStage === 'tone') return 'tone_scheme'
    return String(node.workflowStage)
  }
  if (node.isTemporary) return 'other'
  return 'other'
}

// 兼容旧 import：实现见 stageDetail.ts
export { isImageDetailStage } from './stageDetail'

export function stageLabel(stage: string | null | undefined): string {
  const found = STAGE_COLUMNS.find((item) => item.stage === stage)
  return found?.label ?? stage ?? '节点'
}
