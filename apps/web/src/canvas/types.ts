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
  if (node.workflowStage) {
    if (node.workflowStage === 'style') return 'style_scheme'
    if (node.workflowStage === 'tone') return 'tone_scheme'
    return String(node.workflowStage)
  }
  if (node.moduleKey === 'layout') return 'layout'
  if (node.moduleKey === 'floorplan') return 'floorplan'
  if (node.isTemporary) return 'other'
  return 'other'
}

export function stageLabel(stage: string | null | undefined): string {
  const found = STAGE_COLUMNS.find((item) => item.stage === stage)
  return found?.label ?? stage ?? '节点'
}
