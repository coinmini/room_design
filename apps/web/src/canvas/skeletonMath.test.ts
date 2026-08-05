import { describe, expect, it } from 'vitest'
import { expectedSkeletonSlots } from './skeletonMath'
import type { CanvasGraphNode } from './types'

const parent: CanvasGraphNode = {
  id: 'n1',
  assetId: 'a1',
  variantId: 'v1',
  workflowStage: 'layout',
}

describe('expectedSkeletonSlots', () => {
  it('layout defaults to 2 slots', () => {
    const slots = expectedSkeletonSlots('generate_layout', parent)
    expect(slots).toHaveLength(2)
    expect(slots[0].workflowStage).toBe('layout')
    expect(slots[0].parentAssetId).toBe('a1')
    expect(slots[0].parentNodeId).toBe('n1')
  })

  it('color plan defaults to 4 slots', () => {
    expect(expectedSkeletonSlots('generate_color_plan', parent)).toHaveLength(4)
  })

  it('space render follows selectedSpaceIds', () => {
    const slots = expectedSkeletonSlots('generate_space_render', parent, {
      selectedSpaceIds: ['living', 'bed'],
    })
    expect(slots).toHaveLength(2)
    expect(slots.map((s) => s.label)).toEqual(['分空间 1', '分空间 2'])
  })

  it('style / tone / axonometric follow multi-select extras', () => {
    expect(
      expectedSkeletonSlots('generate_style_scheme', parent, {
        selectedStyleVariants: ['a', 'b', 'c'],
      }),
    ).toHaveLength(3)
    expect(
      expectedSkeletonSlots('generate_tone_scheme', parent, {
        selectedToneVariants: ['x'],
      }),
    ).toHaveLength(1)
    expect(
      expectedSkeletonSlots('generate_axonometric', parent, {
        selectedAxonometricVariants: ['top', 'iso'],
      }),
    ).toHaveLength(2)
  })

  it('local_edit and floorplan upload are single slot', () => {
    expect(expectedSkeletonSlots('local_edit', parent)).toHaveLength(1)
    expect(expectedSkeletonSlots('upload_floorplan_submit', null)).toHaveLength(
      1,
    )
    expect(
      expectedSkeletonSlots('upload_floorplan_submit', null)[0].workflowStage,
    ).toBe('floorplan')
  })
})
