import { describe, expect, it } from 'vitest'
import { skeletonCountForAction } from './resumeActiveJobs'
import type { Job } from '../api'

function job(payload: Record<string, unknown> = {}): Job {
  return {
    id: 'j',
    type: 'LAYOUT_AI',
    status: 'RUNNING',
    payload,
  } as Job
}

describe('skeletonCountForAction', () => {
  it('layout uses payload count', () => {
    expect(skeletonCountForAction('generate_layout', job({ count: 3 }))).toBe(3)
    expect(skeletonCountForAction('generate_layout', job({}))).toBe(2)
  })

  it('fixed batch sizes for color / style / tone / axon', () => {
    expect(skeletonCountForAction('generate_color_plan', job())).toBe(4)
    expect(skeletonCountForAction('generate_style_scheme', job())).toBe(3)
    expect(skeletonCountForAction('generate_tone_scheme', job())).toBe(3)
    expect(skeletonCountForAction('generate_axonometric', job())).toBe(3)
  })

  it('space render counts selected ids', () => {
    expect(
      skeletonCountForAction(
        'generate_space_render',
        job({ selected_space_ids: 'a,b,c' }),
      ),
    ).toBe(3)
    expect(skeletonCountForAction('generate_space_render', job({}))).toBe(1)
  })
})
