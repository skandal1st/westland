import { describe, expect, it } from 'vitest'
import { checkoutRecoveryKey, readCheckoutAttempt } from './checkout-recovery'

const attempt = { version: 1, payload: { cartId: 'cart-before-commit', cartVersion: 7, idempotencyKey: '12345678-1234-4234-8234-123456789012', deliveryLocationId: 'point-1', comment: 'Оставить у менеджера' } }

describe('checkout recovery contract', () => {
  it('restores the exact request even when the live cart was cleared or changed', () => {
    const restored = readCheckoutAttempt(JSON.stringify(attempt))!
    expect(restored.payload).toEqual(attempt.payload)
    expect(restored.payload.cartVersion).toBe(7)
    expect(restored.payload.idempotencyKey).toBe(attempt.payload.idempotencyKey)
  })
  it('retains a known order ID for read-only navigation after a lost page transition', () => {
    expect(readCheckoutAttempt(JSON.stringify({ ...attempt, orderId: 'saved-order' }))?.orderId).toBe('saved-order')
  })
  it.each([null, '{broken', JSON.stringify({ version: 2, payload: attempt.payload }), JSON.stringify({ ...attempt, payload: { ...attempt.payload, cartVersion: -1 } }), JSON.stringify({ ...attempt, payload: { ...attempt.payload, idempotencyKey: '' } })])('rejects unusable stored state instead of inventing a new request: %s', value => {
    expect(readCheckoutAttempt(value)).toBeNull()
  })
  it('isolates attempts by account and store without delimiter collisions', () => {
    expect(checkoutRecoveryKey('one', 'buyer')).not.toBe(checkoutRecoveryKey('two', 'buyer'))
    expect(checkoutRecoveryKey('one', 'buyer')).not.toBe(checkoutRecoveryKey('one', 'other'))
    expect(checkoutRecoveryKey('a:b', 'c')).not.toBe(checkoutRecoveryKey('a', 'b:c'))
  })
})
