import { describe, expect, it } from 'vitest'
import { actionLabel } from './actionLabels'

describe('actionLabel', () => {
  it('returns Chinese short labels for known actions', () => {
    expect(actionLabel('generate_layout')).toBe('02 布局')
    expect(actionLabel('generate_color_plan')).toBe('03 彩平')
    expect(actionLabel('local_edit')).toBe('08 局部修改')
  })

  it('falls back to raw action for unknown keys', () => {
    expect(actionLabel('custom_x')).toBe('custom_x')
  })
})
