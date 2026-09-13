import { describe, expect, it } from 'vitest'
import { redact } from '@/lib/logger'

describe('redact', () => {
  it('redacts sensitive keys regardless of case', () => {
    const out = redact({ password: 'p', Token: 't', DATABASE_URL: 'x', keep: 'ok' }) as Record<string, unknown>
    expect(out.password).toBe('[redacted]')
    expect(out.Token).toBe('[redacted]')
    expect(out.DATABASE_URL).toBe('[redacted]')
    expect(out.keep).toBe('ok')
  })

  it('redacts connection URLs with embedded credentials', () => {
    expect(redact('postgresql://user:secret@host:5432/db')).toBe('[redacted]')
    expect(redact('https://example.com/path')).toBe('https://example.com/path')
  })

  it('handles nested objects and arrays', () => {
    const out = redact({ nested: { apiKey: 'k' }, list: [{ secret: 's' }] }) as any
    expect(out.nested.apiKey).toBe('[redacted]')
    expect(out.list[0].secret).toBe('[redacted]')
  })

  it('tolerates circular references', () => {
    const a: any = { name: 'a' }
    a.self = a
    expect(() => redact(a)).not.toThrow()
  })
})
