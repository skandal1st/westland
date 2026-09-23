import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), order: vi.fn(), invoice: vi.fn() }))
vi.mock('@/lib/authz', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/db', () => ({ prisma: { order: { findFirst: mocks.order } } }))
vi.mock('@/lib/invoices/invoices', () => ({ getCurrentInvoice: mocks.invoice }))
import { GET } from './route'
const request = new Request('http://x/api/orders/order-1')
const params = { params: { id: 'order-1' } }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({ id: 'buyer', storeId: 'trusted' })
  mocks.invoice.mockResolvedValue(null)
})
describe('buyer order recovery read', () => {
  it('requires authentication', async () => {
    mocks.user.mockResolvedValue(null)
    expect((await GET(request, params)).status).toBe(401)
    expect(mocks.order).not.toHaveBeenCalled()
  })
  it('scopes an arbitrary order URL to the current buyer and store', async () => {
    mocks.order.mockResolvedValue(null)
    expect((await GET(request, params)).status).toBe(404)
    expect(mocks.order).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'order-1', storeId: 'trusted', userId: 'buyer' } }))
    expect(mocks.invoice).not.toHaveBeenCalled()
  })
  it.each([
    [null, false], [{ status: 'PENDING', attempts: 0 }, false], [{ status: 'PROCESSING', attempts: 0 }, true],
    [{ status: 'DELIVERED', attempts: 1 }, true], [{ status: 'SUCCESS', attempts: 0 }, true],
  ])('returns the correct cancellation path for export %j', async (delivery, started) => {
    mocks.order.mockResolvedValue({ id: 'order-1', number: 'Q-1', status: 'SUBMITTED', total: 90, currency: 'RUB', comment: '', createdAt: new Date(), cancellationRequestedAt: null, providerDecisionMessage: null, manualConfirmation: null, items: [], export: delivery })
    const data = await (await GET(request, params)).json()
    expect(data.transferStarted).toBe(started)
    expect(data.erpConfirmed).toBe(false)
    expect(data.manuallyConfirmed).toBe(false)
  })
})
