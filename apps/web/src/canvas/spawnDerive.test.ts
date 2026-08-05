import { describe, expect, it } from 'vitest'
import type { CanvasGraphNode } from './types'
import {
  canSpawnFromNode,
  dialogModeForAction,
  primarySpawnForNode,
  resolveSpawnSourceNode,
  spawnOptionsForNode,
  SPAWN_DIALOG_ACTIONS,
} from './spawnDerive'

const node = (
  stage: string,
  overrides: Partial<CanvasGraphNode> = {},
): CanvasGraphNode => ({
  id: `${stage}:v1`,
  variantId: 'v1',
  workflowStage: stage,
  approved: false,
  ...overrides,
})

describe('spawnDerive', () => {
  it('maps every mid-stage to a primary spawn target', () => {
    expect(primarySpawnForNode(node('layout'))?.action).toBe(
      'generate_color_plan',
    )
    expect(primarySpawnForNode(node('color_plan'))?.action).toBe(
      'generate_axonometric',
    )
    expect(primarySpawnForNode(node('axonometric'))?.action).toBe(
      'generate_space_render',
    )
    expect(primarySpawnForNode(node('space_render'))?.action).toBe(
      'generate_style_scheme',
    )
    expect(primarySpawnForNode(node('style_scheme'))?.action).toBe(
      'generate_tone_scheme',
    )
    expect(primarySpawnForNode(node('tone_scheme'))?.action).toBe('local_edit')
    expect(primarySpawnForNode(node('local_edit'))).toBeNull()
  })

  it('color_plan offers axonometric and space_render for mop-wire menu', () => {
    const opts = spawnOptionsForNode(node('color_plan', { approved: true }))
    expect(opts.map((o) => o.action)).toEqual([
      'generate_axonometric',
      'generate_space_render',
    ])
    expect(opts.map((o) => o.label)).toEqual([
      '生成轴侧图',
      '生成分空间图',
    ])
  })

  it('allows floorplan spawn only after stage01 confirmed', () => {
    const fp = node('floorplan', { jobId: 'j1', moduleKey: 'floorplan' })
    expect(canSpawnFromNode(fp)).toBe(false)
    expect(canSpawnFromNode(fp, { stage01Confirmed: true })).toBe(true)
  })

  it('allows approved layout/color stacks to spawn', () => {
    const layout = node('layout', { approved: true })
    expect(canSpawnFromNode(layout)).toBe(true)

    const stack = node('layout', {
      isStack: true,
      approved: false,
      stackItems: [
        node('layout', { id: 'a', approved: false }),
        node('layout', { id: 'b', approved: true, variantId: 'ok' }),
      ],
    })
    expect(canSpawnFromNode(stack)).toBe(true)
    expect(resolveSpawnSourceNode(stack)?.variantId).toBe('ok')
  })

  it('blocks unapproved nodes from spawning', () => {
    expect(canSpawnFromNode(node('color_plan', { approved: false }))).toBe(
      false,
    )
  })

  it('maps dialog actions bidirectionally', () => {
    for (const action of SPAWN_DIALOG_ACTIONS) {
      const mode = dialogModeForAction(action)
      expect(mode).toBeTruthy()
    }
  })
})
