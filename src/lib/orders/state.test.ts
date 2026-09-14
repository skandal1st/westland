import { describe, expect, it } from 'vitest'
import { canTransition, mapProviderStatus } from '@/lib/orders/state'

describe('order state machine', () => {
  it('allows valid business transitions', () => {
    expect(canTransition('DRAFT', 'SUBMITTED')).toBe(true)
    expect(canTransition('SUBMITTED', 'CONFIRMED')).toBe(true)
    expect(canTransition('CONFIRMED', 'PROCESSING')).toBe(true)
    expect(canTransition('PROCESSING', 'COMPLETED')).toBe(true)
    expect(canTransition('SUBMITTED', 'CANCELLED')).toBe(true)
  })

  it('rejects invalid transitions', () => {
    expect(canTransition('DRAFT', 'PROCESSING')).toBe(false)
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false)
    expect(canTransition('CANCELLED', 'CONFIRMED')).toBe(false)
  })

  it('maps opaque provider statuses onto the business lifecycle', () => {
    expect(mapProviderStatus('confirmed')).toBe('CONFIRMED')
    expect(mapProviderStatus('SHIPPED')).toBe('PROCESSING')
    expect(mapProviderStatus('done')).toBe('COMPLETED')
    expect(mapProviderStatus('ERROR_1C')).toBeNull()
  })
})
