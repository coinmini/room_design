/**
 * 拖把线 / 派生下一阶段：各阶段派生动作与生成对话框 mode 映射。
 * 01 依赖结构确认；02–07 依赖本 variant（或堆叠内成员）已批准；08 进局部修改坞。
 * 部分阶段（如 03 彩平）可派生多条下游 → 拖把线弹出选择菜单。
 */

import type { CanvasAction, CanvasGraphNode } from './types'
import { isVariantApproved, normalizeStage } from './types'
import type { GenerateDialogMode } from './GenerateLayoutDialog'

export type SpawnTarget = {
  action: CanvasAction
  /** 生成对话框 mode；local_edit 不走该对话框 */
  mode: GenerateDialogMode | 'local_edit'
  /** 菜单项文案 */
  label: string
  handleTitle: string
  notice: string
  needsApproval: boolean
  needsStage01: boolean
}

/** 各阶段拖把线可选派生（多项时拖线弹菜单） */
const SPAWN_OPTIONS: Record<string, SpawnTarget[]> = {
  floorplan: [
    {
      action: 'generate_layout',
      mode: 'layout',
      label: '生成平面图',
      handleTitle: '拖出以生成平面图',
      notice: '填写布局意向后点击箭头生成平面图',
      needsApproval: false,
      needsStage01: true,
    },
  ],
  layout: [
    {
      action: 'generate_color_plan',
      mode: 'color_plan',
      label: '生成彩平图',
      handleTitle: '拖出以生成彩平图',
      notice: '填写彩平意向后点击箭头生成彩平图',
      needsApproval: true,
      needsStage01: false,
    },
  ],
  color_plan: [
    {
      action: 'generate_axonometric',
      mode: 'axonometric',
      label: '生成轴侧图',
      handleTitle: '拖出选择：轴侧 / 分空间',
      notice: '填写轴侧意向后点击箭头生成轴侧图',
      needsApproval: true,
      needsStage01: false,
    },
    {
      action: 'generate_space_render',
      mode: 'space_render',
      label: '生成分空间图',
      handleTitle: '拖出选择：轴侧 / 分空间',
      notice: '填写分空间意向后点击箭头继续',
      needsApproval: true,
      needsStage01: false,
    },
  ],
  axonometric: [
    {
      action: 'generate_space_render',
      mode: 'space_render',
      label: '生成分空间图',
      handleTitle: '拖出以生成分空间',
      notice: '填写分空间意向后点击箭头继续',
      needsApproval: true,
      needsStage01: false,
    },
  ],
  space_render: [
    {
      action: 'generate_style_scheme',
      mode: 'style_scheme',
      label: '生成风格方案',
      handleTitle: '拖出以生成风格方案',
      notice: '填写风格意向后点击箭头生成风格方案',
      needsApproval: true,
      needsStage01: false,
    },
  ],
  style_scheme: [
    {
      action: 'generate_tone_scheme',
      mode: 'tone_scheme',
      label: '生成色调方案',
      handleTitle: '拖出以生成色调方案',
      notice: '填写色调意向后点击箭头生成色调方案',
      needsApproval: true,
      needsStage01: false,
    },
  ],
  tone_scheme: [
    {
      action: 'local_edit',
      mode: 'local_edit',
      label: '局部修改',
      handleTitle: '拖出以局部修改',
      notice: '进入局部修改：在图上标注并填写说明',
      needsApproval: true,
      needsStage01: false,
    },
  ],
}

/** 需要「生成意向」对话框的动作（不含 local_edit） */
export const SPAWN_DIALOG_ACTIONS: CanvasAction[] = [
  'generate_layout',
  'generate_color_plan',
  'generate_axonometric',
  'generate_space_render',
  'generate_style_scheme',
  'generate_tone_scheme',
]

const ACTION_TO_MODE: Partial<Record<CanvasAction, GenerateDialogMode>> = {
  generate_layout: 'layout',
  generate_color_plan: 'color_plan',
  generate_axonometric: 'axonometric',
  generate_space_render: 'space_render',
  generate_style_scheme: 'style_scheme',
  generate_tone_scheme: 'tone_scheme',
}

const MODE_TO_ACTION: Record<GenerateDialogMode, CanvasAction> = {
  layout: 'generate_layout',
  color_plan: 'generate_color_plan',
  axonometric: 'generate_axonometric',
  space_render: 'generate_space_render',
  style_scheme: 'generate_style_scheme',
  tone_scheme: 'generate_tone_scheme',
}

export function spawnOptionsForStage(stage: string): SpawnTarget[] {
  return SPAWN_OPTIONS[stage] ?? []
}

export function spawnOptionsForNode(node: CanvasGraphNode): SpawnTarget[] {
  return spawnOptionsForStage(normalizeStage(node))
}

/** 阶段主派生（单项时直接打开；多项时菜单第一项） */
export function primarySpawnForStage(stage: string): SpawnTarget | null {
  return spawnOptionsForStage(stage)[0] ?? null
}

export function primarySpawnForNode(node: CanvasGraphNode): SpawnTarget | null {
  return primarySpawnForStage(normalizeStage(node))
}

export function spawnTargetForAction(
  node: CanvasGraphNode,
  action: string,
): SpawnTarget | null {
  return (
    spawnOptionsForNode(node).find((item) => item.action === action) ?? null
  )
}

export function dialogModeForAction(
  action: string,
): GenerateDialogMode | null {
  return ACTION_TO_MODE[action as CanvasAction] ?? null
}

export function actionForDialogMode(mode: GenerateDialogMode): CanvasAction {
  return MODE_TO_ACTION[mode]
}

export function isSpawnDialogAction(action: string): boolean {
  return SPAWN_DIALOG_ACTIONS.includes(action as CanvasAction)
}

/** 堆叠时优先取已批准成员作为派生源 */
export function resolveSpawnSourceNode(
  node: CanvasGraphNode,
): CanvasGraphNode | null {
  if (node.isSkeleton || node.isTemporary) return null
  if (node.isStack) {
    const items = node.stackItems ?? []
    return (
      items.find((item) => isVariantApproved(item)) ??
      items[0] ??
      null
    )
  }
  return node
}

export function nodeHasApprovedSpawnSource(node: CanvasGraphNode): boolean {
  if (node.isStack) {
    return (node.stackItems ?? []).some((item) => isVariantApproved(item))
  }
  return isVariantApproved(node)
}

/**
 * 节点右侧是否显示可拖出的「派生」把手。
 * floorplan：结构已确认；其余：本节点或堆叠内已有批准。
 */
export function canSpawnFromNode(
  node: CanvasGraphNode,
  ctx: { stage01Confirmed?: boolean } = {},
): boolean {
  if (node.isSkeleton || node.isTemporary) return false
  const options = spawnOptionsForNode(node)
  if (!options.length) return false
  const sample = options[0]
  if (sample.needsStage01) {
    return ctx.stage01Confirmed === true
  }
  if (sample.needsApproval) {
    return nodeHasApprovedSpawnSource(node)
  }
  return true
}

export function spawnHandleTitle(
  node: CanvasGraphNode,
  ctx: { stage01Confirmed?: boolean } = {},
): string {
  if (!canSpawnFromNode(node, ctx)) return '拖出连接'
  const options = spawnOptionsForNode(node)
  if (options.length > 1) return '拖出选择生成内容'
  return options[0]?.handleTitle ?? '拖出连接'
}
