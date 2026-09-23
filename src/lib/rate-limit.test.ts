import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientIp, loginRateLimit, rateLimit, resetRateLimits } from '@/lib/rate-limit'

afterEach(() => { resetRateLimits(); vi.useRealTimers() })

describe('rateLimit', () => {
  it('allows the budget, then denies without extending the absolute expiry', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    for (let i = 0; i < 3; i++) expect(rateLimit('a', 3, 60_000).ok).toBe(true)
    vi.setSystemTime(59_000)
    expect(rateLimit('a', 3, 60_000)).toEqual({ ok: false, retryAfterMs: 1000 })
    vi.setSystemTime(60_000)
    expect(rateLimit('a', 3, 60_000).ok).toBe(true)
  })
  it('tracks keys independently', () => {
    expect(rateLimit('a', 1, 60_000).ok).toBe(true)
    expect(rateLimit('a', 1, 60_000).ok).toBe(false)
    expect(rateLimit('b', 1, 60_000).ok).toBe(true)
  })
  it('bounds memory without evicting active limits; expires old keys', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    for (let i = 0; i < 10_000; i++) expect(rateLimit(String(i), 1, 60_000).ok).toBe(true)
    expect(rateLimit('overflow', 1, 60_000).ok).toBe(false)
    expect(rateLimit('0', 1, 60_000).ok).toBe(false)
    vi.setSystemTime(60_000)
    expect(rateLimit('overflow', 1, 60_000).ok).toBe(true)
  })
})

describe('clientIp: single trusted nginx', () => {
  it('ignores spoofed prefix entries and accepts overwrite format', () => {
    for (const prefix of ['1.2.3.4', 'unknown', '1.1.1.1, 2.2.2.2']) {
      expect(clientIp(new Headers({ 'x-forwarded-for': `${prefix}, 5.6.7.8` }))).toBe('5.6.7.8')
    }
    expect(clientIp(new Headers({ 'x-forwarded-for': '5.6.7.8' }))).toBe('5.6.7.8')
    expect(clientIp(new Headers({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9')
    expect(clientIp(new Headers())).toBe('unknown')
  })
  it.each(['', '1.2.3.4,', '1.2.3.4, invalid', '1.2.3.4:80', 'fe80::1%eth0'])('fails closed for invalid final addresses: %s', (value) => {
    expect(clientIp(new Headers({ 'x-forwarded-for': value, 'x-real-ip': '9.9.9.9' }))).toBe('unknown')
  })
  it('canonicalizes equivalent IPv6 spellings', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '2001:0db8:0:0:0:0:0:1' }))).toBe('2001:db8::1')
    expect(clientIp(new Headers({ 'x-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1')
  })
})

describe('login budgets', () => {
  it('normalizes account identity, limits attempts synchronously and isolates other IPs', () => {
    for (let i = 0; i < 5; i++) expect(loginRateLimit('192.0.2.1', 'Buyer@Test.local ').ok).toBe(true)
    expect(loginRateLimit('192.0.2.1', 'buyer@test.local').ok).toBe(false)
    expect(loginRateLimit('192.0.2.2', 'buyer@test.local').ok).toBe(true)
    expect(loginRateLimit('192.0.2.1', 'other@test.local').ok).toBe(true)
  })
  it('limits password spraying across accounts on one IP', () => {
    for (let i = 0; i < 30; i++) expect(loginRateLimit('192.0.2.1', `buyer${i}@test.local`).ok).toBe(true)
    expect(loginRateLimit('192.0.2.1', 'new@test.local').ok).toBe(false)
  })
  it('recovers after a bounded cooldown even if denied requests continue', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    for (let i = 0; i < 5; i++) loginRateLimit('192.0.2.1', 'a@test.local')
    vi.setSystemTime(59_000)
    expect(loginRateLimit('192.0.2.1', 'a@test.local').retryAfterMs).toBe(1000)
    vi.setSystemTime(60_000)
    expect(loginRateLimit('192.0.2.1', 'a@test.local').ok).toBe(true)
  })
})
