import { describe, expect, it } from 'vitest'
import {
  isImageDetailStage,
  primaryDeriveActionsForStage,
  stageDetailMeta,
} from './stageDetail'
import { normalizeStage } from './types'

describe('stageDetail', () => {
  it('marks 02–08 as image detail stages', () => {
    expect(isImageDetailStage('layout')).toBe(true)
    expect(isImageDetailStage('color_plan')).toBe(true)
    expect(isImageDetailStage('axonometric')).toBe(true)
    expect(isImageDetailStage('space_render')).toBe(true)
    expect(isImageDetailStage('style_scheme')).toBe(true)
    expect(isImageDetailStage('tone_scheme')).toBe(true)
    expect(isImageDetailStage('local_edit')).toBe(true)
    expect(isImageDetailStage('floorplan')).toBe(false)
    expect(isImageDetailStage('other')).toBe(false)
  })

  it('provides derive actions per stage chain', () => {
    expect(primaryDeriveActionsForStage('layout').map((a) => a.action)).toEqual([
      'generate_color_plan',
    ])
    expect(
      primaryDeriveActionsForStage('color_plan').map((a) => a.action),
    ).toEqual(['generate_axonometric', 'generate_space_render'])
    expect(
      primaryDeriveActionsForStage('axonometric').map((a) => a.action),
    ).toEqual(['generate_space_render'])
    expect(
      primaryDeriveActionsForStage('space_render').map((a) => a.action),
    ).toEqual(['generate_style_scheme'])
    expect(
      primaryDeriveActionsForStage('style_scheme').map((a) => a.action),
    ).toEqual(['generate_tone_scheme'])
    expect(
      primaryDeriveActionsForStage('tone_scheme').map((a) => a.action),
    ).toEqual(['local_edit'])
    expect(primaryDeriveActionsForStage('local_edit')).toEqual([])
  })

  it('hides approve for local_edit only', () => {
    expect(stageDetailMeta('layout').showApprove).toBe(true)
    expect(stageDetailMeta('axonometric').showApprove).toBe(true)
    expect(stageDetailMeta('local_edit').showApprove).toBe(false)
  })

  it('normalizes 04–08 asset types', () => {
    expect(
      normalizeStage({
        id: 'a',
        variantId: 'v',
        assetType: 'ai_axonometric',
      }),
    ).toBe('axonometric')
    expect(
      normalizeStage({
        id: 'a',
        variantId: 'v',
        assetType: 'ai_space_render',
      }),
    ).toBe('space_render')
    expect(
      normalizeStage({
        id: 'a',
        variantId: 'v',
        title: 'AI 风格方案 · modern',
      }),
    ).toBe('style_scheme')
  })
})
