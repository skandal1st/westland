
import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), checkout: vi.fn() }))
vi.mock('@/lib/authz', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/cart/checkout', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/cart/checkout')>(), checkout: mocks.checkout,
}))
import { POST } from './route'
import { CheckoutError } from '@/lib/cart/checkout'

const payload = { deliveryLocationId: 'delivery', idempotencyKey: 'test-request-key', cartId: 'cart', cartVersion: 7 }
const request = (body: unknown) => new Request('http://localhost/api/checkout', { method: 'POST', body: JSON.stringify(body) })
beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: 'buyer' }) })

it('requires authentication before checkout', async () => {
  mocks.user.mockResolvedValue(null)
  expect((await POST(request(payload))).status).toBe(401)
  expect(mocks.checkout).not.toHaveBeenCalled()
})
it.each([
  { ...payload, cartVersion: undefined },
  { ...payload, cartVersion: -1 },
  { ...payload, cartVersion: 1.5 },
  { ...payload, cartVersion: 2147483648 },
  { ...payload, cartId: undefined },
  { ...payload, idempotencyKey: undefined },
  { ...payload, total: 1 },
])('rejects incomplete, invalid or client-priced checkout: %j', async body => {
  expect((await POST(request(body))).status).toBe(400)
  expect(mocks.checkout).not.toHaveBeenCalled()
})
it.each(['CART_CHANGED', 'IDEMPOTENCY_CONFLICT'] as const)('returns a safe 409 for %s', async code => {
  mocks.checkout.mockRejectedValue(new CheckoutError(code))
  const response = await POST(request(payload))
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: code })
})
it('passes the displayed revision and serializes only public order fields', async () => {
  mocks.checkout.mockResolvedValue({ id: 'order', number: 'WS-00001', status: 'DRAFT', total: 100, currency: 'RUB', checkoutIntent: 'private' })
  const response = await POST(request(payload))
  expect(response.status).toBe(201)
  expect(mocks.checkout).toHaveBeenCalledWith({ id: 'buyer' }, payload)
  expect(await response.json()).toEqual({ orderId: 'order', number: 'WS-00001', status: 'DRAFT', total: '100.00', currency: 'RUB' })
})
