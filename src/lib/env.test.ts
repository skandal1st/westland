import { afterEach, describe, expect, it } from 'vitest'
import { loadEnv, resetEnvCache } from '@/lib/env'

afterEach(() => resetEnvCache())

describe('loadEnv', () => {
  it('accepts a valid environment', () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://u:p@localhost:5432/db' })
    expect(env.DATABASE_URL).toContain('localhost')
    expect(env.NODE_ENV).toBe('test')
  })

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadEnv({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/)
  })

  it('fails fast when DATABASE_URL is not a URL', () => {
    expect(() => loadEnv({ DATABASE_URL: 'not-a-url' })).toThrow(/DATABASE_URL/)
  })

  it('rejects a too-short NEXTAUTH_SECRET', () => {
    expect(() =>
      loadEnv({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db', NEXTAUTH_SECRET: 'short' }),
    ).toThrow(/NEXTAUTH_SECRET/)
  })
})
