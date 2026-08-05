/**
 * 节点阶段判断：01 结构 vs 02–08 图片详情。
 */

import { isImageDetailStage } from './stageDetail'
import type { CanvasGraphNode } from './types'
import { normalizeStage } from './types'

/** 01 户型识别节点（禁止 layout / LAYOUT_AI） */
export function isStage01Node(node: CanvasGraphNode): boolean {
  const stage = normalizeStage(node)
  if (
    node.moduleKey === 'layout' ||
    node.assetType === 'layout_plan' ||
    stage === 'layout'
  ) {
    return false
  }
  if (isImageDetailStage(stage)) {
    return false
  }
  return (
    stage === 'floorplan' ||
    node.moduleKey === 'floorplan' ||
    node.assetType === 'floorplan_analysis'
  )
}

/** 可进图片详情坞的节点：02–08 方案图 */
export function isStageImageDetailNode(node: CanvasGraphNode): boolean {
  return isImageDetailStage(normalizeStage(node))
}
