import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampMenuPosition } from './menuMath'

describe('clampMenuPosition', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps position when menu fits', () => {
    vi.stubGlobal('innerWidth', 1200)
    vi.stubGlobal('innerHeight', 800)
    expect(clampMenuPosition(100, 100, 200, 150)).toEqual({ x: 100, y: 100 })
  })

  it('clamps to bottom-right pad when overflowing', () => {
    vi.stubGlobal('innerWidth', 400)
    vi.stubGlobal('innerHeight', 300)
    const pos = clampMenuPosition(380, 280, 200, 150)
    expect(pos.x).toBeLessThanOrEqual(400 - 200 - 10)
    expect(pos.y).toBeLessThanOrEqual(300 - 150 - 10)
    expect(pos.x).toBeGreaterThanOrEqual(10)
    expect(pos.y).toBeGreaterThanOrEqual(10)
  })
})
