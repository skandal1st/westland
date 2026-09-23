import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), submit: vi.fn(), cancel: vi.fn() }))
vi.mock('@/lib/authz', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/orders/orders', async () => ({ ...(await import('@/lib/orders/errors')), submitOrder: mocks.submit, cancelOrder: mocks.cancel }))
import { POST } from './route'
import { POST as cancel } from '../cancel/route'
import { OrderError } from '@/lib/orders/errors'

const params = { params: { id: 'order' } }
const request = (body?: string) => new Request('http://localhost/api/orders/order/submit', { method: 'POST', ...(body === undefined ? {} : { body }) })
beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: 'buyer' }) })

it('requires authentication for submission and cancellation', async () => {
  mocks.user.mockResolvedValue(null)
  expect((await POST(request(), params)).status).toBe(401)
  expect((await cancel(request(), params)).status).toBe(401)
  expect(mocks.submit).not.toHaveBeenCalled()
  expect(mocks.cancel).not.toHaveBeenCalled()
})
it.each(['{', 'null', '{"total":1}', '{"confirmed":true}', '{"priceConfirmationToken":"bad"}'])('rejects malformed or client-authoritative body %s', async body => {
  expect((await POST(request(body), params)).status).toBe(400)
  expect(mocks.submit).not.toHaveBeenCalled()
})
it.each([undefined, '{}'])('accepts empty legacy submit body %s without implicitly accepting new prices', async body => {
  mocks.submit.mockResolvedValue({ id: 'order', number: 'WS-1', status: 'SUBMITTED', total: 100, currency: 'RUB' })
  expect((await POST(request(body), params)).status).toBe(200)
  expect(mocks.submit).toHaveBeenCalledWith({ id: 'buyer' }, 'order', undefined, {})
})
it('forwards only the explicit price confirmation token', async () => {
  const token = '00000000-0000-4000-8000-000000000001'
  mocks.submit.mockResolvedValue({ id: 'order', number: 'WS-1', status: 'SUBMITTED', total: 125, currency: 'RUB' })
  expect((await POST(request(JSON.stringify({ priceConfirmationToken: token })), params)).status).toBe(200)
  expect(mocks.submit).toHaveBeenCalledWith({ id: 'buyer' }, 'order', undefined, { priceConfirmationToken: token })
})
it('returns price changes with 409 instead of a success response', async () => {
  const quote = { token: 'token', total: '125.00', previousTotal: '100.00', currency: 'RUB', previousCurrency: 'RUB', lines: [] }
  mocks.submit.mockRejectedValue(new OrderError('PRICE_CHANGED', quote))
  const response = await POST(request(), params)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: 'PRICE_CHANGED', quote })
})
it.each(['DRAFT_EXPIRED', 'ITEM_UNAVAILABLE', 'CHANNEL_UNAVAILABLE'] as const)('returns 409 for %s', async code => {
  mocks.submit.mockRejectedValue(new OrderError(code))
  const response = await POST(request(), params)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ error: code })
})
it('does not expose foreign orders', async () => {
  mocks.submit.mockRejectedValue(new OrderError('NOT_FOUND'))
  expect((await POST(request(), params)).status).toBe(404)
})
it('represents post-transmission cancellation as a request, not CANCELLED', async () => {
  mocks.cancel.mockResolvedValue({ order: { id: 'order', status: 'SUBMITTED', cancellationRequestedAt: new Date('2026-09-21T10:00:00Z') }, requested: true })
  const response = await cancel(request(), params)
  expect(await response.json()).toMatchObject({ status: 'SUBMITTED', requested: true })
})
