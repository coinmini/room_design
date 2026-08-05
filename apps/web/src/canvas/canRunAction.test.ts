import { describe, expect, it } from 'vitest'
import {
  allowedParentStagesFor,
  canRunAction,
  isEditableTarget,
  listNodeActions,
} from './canRunAction'
import type { CanvasGraphNode } from './types'

const baseNode = (overrides: Partial<CanvasGraphNode> = {}): CanvasGraphNode => ({
  id: 'asset:variant',
  assetId: 'asset',
  variantId: 'variant',
  workflowStage: 'color_plan',
  approved: false,
  ...overrides,
})

describe('canRunAction', () => {
  it('matches main.py parent stage constraints', () => {
    expect(allowedParentStagesFor('color_plan')).toEqual(['layout', 'floorplan'])
    expect(allowedParentStagesFor('tone_scheme')).toEqual(['style_scheme'])
    expect(allowedParentStagesFor('local_edit')).toEqual(['tone_scheme'])
  })

  it('blocks generate when not approved', () => {
    const result = canRunAction(baseNode(), 'generate_axonometric')
    expect(result.enabled).toBe(false)
    expect(result.reason).toMatch(/批准/)
  })

  it('allows generate when approved', () => {
    const result = canRunAction(baseNode({ approved: true }), 'generate_axonometric')
    expect(result.enabled).toBe(true)
  })

  it('blocks generate_layout until stage01 is confirmed', () => {
    const node = baseNode({
      workflowStage: undefined,
      moduleKey: 'floorplan',
      jobId: 'job_1',
    })
    const blocked = canRunAction(node, 'generate_layout', {
      stage01Confirmed: false,
    })
    expect(blocked.enabled).toBe(false)
    const ok = canRunAction(node, 'generate_layout', {
      stage01Confirmed: true,
    })
    expect(ok.enabled).toBe(true)
  })

  it('allows approving another variant when downstream exists (W0-X fork)', () => {
    const result = canRunAction(baseNode({ approved: false }), 'approve', {
      hasDownstream: true,
    })
    expect(result.enabled).toBe(true)
  })

  it('lists stage actions for space_render', () => {
    const actions = listNodeActions(
      baseNode({ workflowStage: 'space_render', approved: true }),
    )
    const names = actions.map((item) => item.action)
    expect(names).toContain('generate_style_scheme')
    expect(names).toContain('approve')
  })

  it('guards editable targets for shortcuts', () => {
    const input = document.createElement('input')
    expect(isEditableTarget(input)).toBe(true)
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
  })
})
