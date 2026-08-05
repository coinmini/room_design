import { describe, expect, it } from 'vitest'
import {
  canOpenStageDetail,
  isImageDetailStage,
  primaryDeriveActionsForStage,
  stageDetailMeta,
} from './stageDetail'
import { normalizeStage } from './types'

describe('stageDetail', () => {
  it('marks 02–08 as image detail stages; 01 opens detail separately', () => {
    expect(isImageDetailStage('layout')).toBe(true)
    expect(isImageDetailStage('color_plan')).toBe(true)
    expect(isImageDetailStage('axonometric')).toBe(true)
    expect(isImageDetailStage('space_render')).toBe(true)
    expect(isImageDetailStage('style_scheme')).toBe(true)
    expect(isImageDetailStage('tone_scheme')).toBe(true)
    expect(isImageDetailStage('local_edit')).toBe(true)
    expect(isImageDetailStage('floorplan')).toBe(false)
    expect(isImageDetailStage('other')).toBe(false)
    expect(canOpenStageDetail('floorplan')).toBe(true)
    expect(canOpenStageDetail('layout')).toBe(true)
    expect(canOpenStageDetail('other')).toBe(false)
  })

  it('provides derive actions per stage chain', () => {
    expect(primaryDeriveActionsForStage('floorplan').map((a) => a.action)).toEqual([
      'view_structure',
      'generate_layout',
    ])
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

  it('hides approve for floorplan and local_edit', () => {
    expect(stageDetailMeta('floorplan').showApprove).toBe(false)
    expect(stageDetailMeta('floorplan').imageClickHint).toBeTruthy()
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
