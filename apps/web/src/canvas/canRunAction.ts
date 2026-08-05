/**
 * W4-1：节点操作可用性纯函数。
 * 父类型约束对齐 main.py `_validate_parent_asset`（约 665–717 行）与方案第 6 章。
 */

import type {
  ActionAvailability,
  CanvasAction,
  CanvasGraphNode,
} from './types'
import { isVariantApproved, normalizeStage } from './types'

export type ActionContext = {
  /** 该资产是否已有下游子资产（改批抑制） */
  hasDownstream?: boolean
  /** 当前批准 variant 是否就是本节点 */
  isApprovedVariant?: boolean
  isEditableTarget?: boolean
  /** 01 结构是否已在 FloorplanModule 中人工确认 */
  stage01Confirmed?: boolean
}

const STAGE_ACTIONS: Record<string, CanvasAction[]> = {
  floorplan: ['view_structure', 'reanalyze', 'generate_layout', 'open_full', 'download'],
  layout: ['approve', 'unapprove', 'generate_color_plan', 'open_full', 'download'],
  color_plan: [
    'approve',
    'unapprove',
    'set_baseline',
    'generate_axonometric',
    'generate_space_render',
    'open_full',
    'download',
  ],
  axonometric: [
    'approve',
    'unapprove',
    'generate_space_render',
    'open_full',
    'download',
  ],
  space_render: [
    'approve',
    'unapprove',
    'set_baseline',
    'generate_style_scheme',
    'open_full',
    'download',
  ],
  style_scheme: [
    'approve',
    'unapprove',
    'set_baseline',
    'generate_tone_scheme',
    'open_full',
    'download',
  ],
  tone_scheme: [
    'approve',
    'unapprove',
    'set_baseline',
    'local_edit',
    'open_full',
    'download',
  ],
  local_edit: ['open_full', 'download'],
  other: ['open_full', 'download', 'retry'],
}

const LABELS: Record<CanvasAction, string> = {
  approve: '批准',
  unapprove: '取消批准',
  set_baseline: '设为基准',
  generate_layout: '生成布局',
  generate_color_plan: '生成彩平',
  generate_axonometric: '生成轴侧',
  generate_space_render: '生成分空间',
  generate_style_scheme: '生成风格方案',
  generate_tone_scheme: '生成色调方案',
  local_edit: '局部修改',
  retry: '重试',
  open_full: '打开原图',
  download: '下载',
  copy_node: '复制节点',
  duplicate: '创建副本',
  delete: '删除',
  rebind_baseline: '重新绑定基准',
  view_structure: '编辑结构',
  reanalyze: '重新识别',
}

const SHORTCUTS: Partial<Record<CanvasAction, string>> = {
  copy_node: '⌘C',
  duplicate: '⌘D',
  delete: '⌘⌫',
  open_full: '↵',
}

/** 合法上游阶段（对齐 main.py 父类型约束） */
export function allowedParentStagesFor(childStage: string): string[] {
  switch (childStage) {
    case 'color_plan':
      return ['layout', 'floorplan']
    case 'axonometric':
      return ['color_plan']
    case 'space_render':
      return ['color_plan', 'axonometric']
    case 'style_scheme':
      return ['space_render']
    case 'tone_scheme':
      return ['style_scheme']
    case 'local_edit':
      return ['tone_scheme']
    case 'layout':
      return ['floorplan']
    default:
      return []
  }
}

export function canRunAction(
  node: CanvasGraphNode,
  action: CanvasAction,
  ctx: ActionContext = {},
): ActionAvailability {
  const stage = normalizeStage(node)
  const label = LABELS[action]
  const shortcut = SHORTCUTS[action]
  const base = { action, label, shortcut }

  if (node.isTemporary || node.isSkeleton) {
    if (action === 'retry' && node.jobStatus === 'FAILED') {
      return { ...base, enabled: true, label: '重试' }
    }
    if (
      action === 'delete' &&
      (node.jobStatus === 'FAILED' ||
        node.jobStatus === 'CANCELED' ||
        (node.isTemporary && node.jobStatus !== 'RUNNING'))
    ) {
      return {
        ...base,
        enabled: true,
        label: node.isSkeleton ? '丢弃' : '删除',
      }
    }
    if (action === 'open_full' || action === 'download') {
      return { ...base, enabled: Boolean(node.url) }
    }
    return {
      ...base,
      enabled: false,
      reason: node.isSkeleton
        ? node.jobStatus === 'FAILED'
          ? '可重试或丢弃'
          : '生成中，请稍候'
        : '临时结果不可审批或派生',
    }
  }

  if (action === 'delete' || action === 'duplicate' || action === 'copy_node') {
    return {
      ...base,
      enabled: true,
      reason: undefined,
    }
  }

  if (action === 'open_full' || action === 'download') {
    return { ...base, enabled: Boolean(node.url) }
  }

  if (action === 'rebind_baseline') {
    return {
      ...base,
      enabled: true,
      reason: '上游已变更，需重新绑定基准',
    }
  }

  const stageActions = STAGE_ACTIONS[stage] ?? STAGE_ACTIONS.other
  if (!stageActions.includes(action) && action !== 'retry') {
    return {
      ...base,
      enabled: false,
      reason: `当前阶段（${stage}）不支持此操作`,
    }
  }

  const approved = ctx.isApprovedVariant ?? isVariantApproved(node)

  // 派生类操作要求已批准
  const needsApproval: CanvasAction[] = [
    'generate_color_plan',
    'generate_axonometric',
    'generate_space_render',
    'generate_style_scheme',
    'generate_tone_scheme',
    'local_edit',
    'set_baseline',
  ]
  if (needsApproval.includes(action) && !approved && action !== 'set_baseline') {
    // set_baseline / approve 本身不需要已批准
  }
  if (
    [
      'generate_color_plan',
      'generate_axonometric',
      'generate_space_render',
      'generate_style_scheme',
      'generate_tone_scheme',
      'local_edit',
    ].includes(action)
  ) {
    if (!approved) {
      return {
        ...base,
        enabled: false,
        reason: '需先批准本节点，才能派生下游',
      }
    }
  }

  // 01→02：必须先在结构编辑器中确认（未传或 false 均不可生成）
  if (action === 'generate_layout' && ctx.stage01Confirmed !== true) {
    return {
      ...base,
      enabled: false,
      reason: '请先打开结构编辑器并确认结构',
    }
  }

  // W0-X：已有下游时仍可批准其他 variant 分叉；仅提示信息，不置灰

  if (action === 'approve' && approved) {
    return { ...base, enabled: false, reason: '已是批准版本，可取消批准' }
  }

  if (action === 'unapprove') {
    if (!approved) {
      return { ...base, enabled: false, reason: '尚未批准' }
    }
    return { ...base, enabled: true }
  }

  return { ...base, enabled: true }
}

export function listNodeActions(
  node: CanvasGraphNode,
  ctx: ActionContext = {},
): ActionAvailability[] {
  // 骨架 / 临时节点：只暴露重试、丢弃、打开/下载
  if (node.isSkeleton || node.isTemporary) {
    const ordered: CanvasAction[] = []
    if (node.jobStatus === 'FAILED') ordered.push('retry')
    if (
      node.jobStatus === 'FAILED' ||
      node.jobStatus === 'CANCELED' ||
      (node.isTemporary && node.jobStatus !== 'RUNNING')
    ) {
      ordered.push('delete')
    }
    if (node.url) {
      ordered.push('open_full', 'download')
    }
    return ordered.map((action) => canRunAction(node, action, ctx))
  }

  const stage = normalizeStage(node)
  const approved = ctx.isApprovedVariant ?? isVariantApproved(node)
  const actions = [
    ...(STAGE_ACTIONS[stage] ?? STAGE_ACTIONS.other),
    'copy_node' as const,
    'duplicate' as const,
    'delete' as const,
  ]
  // 去重；已批准只显示「取消批准」，未批准只显示「批准」
  const seen = new Set<CanvasAction>()
  const ordered: CanvasAction[] = []
  for (const action of actions) {
    if (seen.has(action)) continue
    if (action === 'approve' && approved) continue
    if (action === 'unapprove' && !approved) continue
    seen.add(action)
    ordered.push(action)
  }
  return ordered.map((action) => canRunAction(node, action, ctx))
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (target.isContentEditable) return true
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}
