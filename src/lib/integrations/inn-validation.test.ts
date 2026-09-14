import { describe, expect, it } from 'vitest'
import { mockInnValidator } from '@/lib/integrations/inn-validation'

describe('mockInnValidator', () => {
  it('accepts 10 and 12 digit INNs', async () => {
    expect((await mockInnValidator.validate('7712345678')).valid).toBe(true)
    expect((await mockInnValidator.validate('771234567890')).valid).toBe(true)
  })

  it('rejects wrong length or non-digits', async () => {
    expect((await mockInnValidator.validate('123')).valid).toBe(false)
    expect((await mockInnValidator.validate('77123456AB')).valid).toBe(false)
    const bad = await mockInnValidator.validate('')
    expect(bad.valid).toBe(false)
    expect(bad.reason).toBeDefined()
  })
})
