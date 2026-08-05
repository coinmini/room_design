import { describe, expect, it } from 'vitest'
import { isStage01Node, isStageImageDetailNode } from './nodeStage'
import type { CanvasGraphNode } from './types'

describe('nodeStage', () => {
  it('detects floorplan as stage 01, not layout', () => {
    const floorplan: CanvasGraphNode = {
      id: '1',
      variantId: 'a',
      moduleKey: 'floorplan',
      workflowStage: 'floorplan',
      assetType: 'floorplan_analysis',
    }
    const layout: CanvasGraphNode = {
      id: '2',
      variantId: 'v1',
      moduleKey: 'layout',
      workflowStage: 'layout',
      assetType: 'layout_plan',
    }
    expect(isStage01Node(floorplan)).toBe(true)
    expect(isStage01Node(layout)).toBe(false)
    expect(isStageImageDetailNode(layout)).toBe(true)
    expect(isStageImageDetailNode(floorplan)).toBe(false)
  })

  it('treats color_plan as image detail, not stage 01', () => {
    const node: CanvasGraphNode = {
      id: '3',
      variantId: 'c1',
      workflowStage: 'color_plan',
    }
    expect(isStage01Node(node)).toBe(false)
    expect(isStageImageDetailNode(node)).toBe(true)
  })
})
