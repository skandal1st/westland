import { afterEach, describe, expect, it } from 'vitest'
import { clientIp, rateLimit, resetRateLimits } from '@/lib/rate-limit'

afterEach(() => resetRateLimits())

describe('rateLimit', () => {
  it('allows up to the limit then blocks within the window', () => {
    const key = 'test-key'
    for (let i = 0; i < 3; i++) expect(rateLimit(key, 3, 60_000).ok).toBe(true)
    const blocked = rateLimit(key, 3, 60_000)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
  })

  it('tracks keys independently', () => {
    expect(rateLimit('a', 1, 60_000).ok).toBe(true)
    expect(rateLimit('a', 1, 60_000).ok).toBe(false)
    expect(rateLimit('b', 1, 60_000).ok).toBe(true)
  })
})

describe('clientIp', () => {
  it('prefers the first x-forwarded-for entry', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4')
    expect(clientIp(new Headers({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9')
    expect(clientIp(new Headers())).toBe('unknown')
  })
})
