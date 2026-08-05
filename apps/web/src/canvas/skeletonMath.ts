/**
 * 生成任务骨架占位：点击后立刻显示，避免「后台在跑、界面没反应」。
 */

import type { CanvasGraphNode } from './types'

export type SkeletonSlot = {
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
  /** QUEUED | RUNNING | FAILED | CANCELED */
  jobStatus?: string
  /** 已完成张数 / 总张数（进度文案） */
  succeededCount?: number
  totalCount?: number
  /** partial 已出图时的预览 URL */
  url?: string | null
  errorMessage?: string | null
}

export type SkeletonExtras = {
  selectedSpaceIds?: string[]
  selectedStyleVariants?: string[]
  selectedToneVariants?: string[]
  selectedAxonometricVariants?: string[]
}

export function expectedSkeletonSlots(
  action: string,
  parent: CanvasGraphNode | null,
  extras?: SkeletonExtras,
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
    const ids = extras?.selectedAxonometricVariants
    if (ids?.length) {
      return ids.map((_id, i) => ({
        label: `轴侧 ${i + 1}`,
        workflowStage: 'axonometric',
        parentAssetId,
        parentNodeId,
      }))
    }
    return [1, 2, 3].map((n) => ({
      label: `轴侧 ${n}`,
      workflowStage: 'axonometric',
      parentAssetId,
      parentNodeId,
    }))
  }
  if (action === 'generate_style_scheme') {
    const ids = extras?.selectedStyleVariants
    if (ids?.length) {
      return ids.map((_id, i) => ({
        label: `风格 ${i + 1}`,
        workflowStage: 'style_scheme',
        parentAssetId,
        parentNodeId,
      }))
    }
    return [1, 2, 3].map((n) => ({
      label: `风格 ${n}`,
      workflowStage: 'style_scheme',
      parentAssetId,
      parentNodeId,
    }))
  }
  if (action === 'generate_tone_scheme') {
    const ids = extras?.selectedToneVariants
    if (ids?.length) {
      return ids.map((_id, i) => ({
        label: `色调 ${i + 1}`,
        workflowStage: 'tone_scheme',
        parentAssetId,
        parentNodeId,
      }))
    }
    return [1, 2, 3].map((n) => ({
      label: `色调 ${n}`,
      workflowStage: 'tone_scheme',
      parentAssetId,
      parentNodeId,
    }))
  }
  if (action === 'generate_space_render') {
    const ids = extras?.selectedSpaceIds
    if (ids?.length) {
      return ids.map((_id, i) => ({
        label: `分空间 ${i + 1}`,
        workflowStage: 'space_render',
        parentAssetId,
        parentNodeId,
      }))
    }
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
