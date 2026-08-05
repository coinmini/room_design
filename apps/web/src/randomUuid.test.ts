import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUuid } from './api'

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('randomUuid', () => {
  it('uses crypto.randomUUID when it exists', () => {
    const spy = vi.fn(() => '11111111-2222-4333-8444-555555555555')
    vi.stubGlobal('crypto', { randomUUID: spy, getRandomValues: vi.fn() })
    expect(randomUuid()).toBe('11111111-2222-4333-8444-555555555555')
    expect(spy).toHaveBeenCalledOnce()
  })

  // 明文 HTTP + IP 部署时 crypto.randomUUID 不存在（非 secure context），
  // 早前这里会抛 "crypto.randomUUID is not a function" 导致新建项目失败。
  it('falls back to getRandomValues when randomUUID is missing', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (buf: Uint8Array) => {
        for (let i = 0; i < buf.length; i += 1) buf[i] = i * 7
        return buf
      },
    })
    expect(randomUuid()).toMatch(UUID_V4)
  })

  it('still returns a valid uuid with no crypto at all', () => {
    vi.stubGlobal('crypto', undefined)
    expect(randomUuid()).toMatch(UUID_V4)
  })

  it('produces distinct values across calls', () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomUuid()))
    expect(seen.size).toBe(200)
  })
})
