import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), order: vi.fn() }))
vi.mock('@/lib/authz', () => ({ requireApiUser: mocks.auth }))
vi.mock('@/lib/db', () => ({ prisma: { order: { findFirst: mocks.order } } }))

import { GET } from './route'

const request = new Request('http://x/api/staff/orders/order-1')
const params = { params: { id: 'order-1' } }
const decimal = (value: string) => ({ toFixed: () => value, toString: () => value.replace(/\.0+$/, '') })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'staff', storeId: 'trusted', role: 'STAFF' } })
})

describe('staff order composition read', () => {
  it('returns authorization failures before reading an order', async () => {
    mocks.auth.mockResolvedValue({ response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) })

    expect((await GET(request, params)).status).toBe(403)
    expect(mocks.order).not.toHaveBeenCalled()
  })

  it('scopes an arbitrary order URL to the authenticated store', async () => {
    mocks.order.mockResolvedValue(null)

    expect((await GET(request, params)).status).toBe(404)
    expect(mocks.order).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'order-1', storeId: 'trusted' } }))
  })

  it('returns immutable line snapshots formatted for the backoffice', async () => {
    mocks.order.mockResolvedValue({
      id: 'order-1', number: 'WS-42', total: decimal('244.00'), currency: 'RUB', comment: 'Позвонить перед доставкой',
      items: [{ id: 'line-1', sku: 'SKU-1', sourceSku: 'ART-1', productName: 'Товар', packaging: 'коробка', quantity: decimal('2.000'), unitPrice: decimal('122.00'), lineTotal: decimal('244.00') }],
    })

    const response = await GET(request, params)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      id: 'order-1', number: 'WS-42', total: '244.00', currency: 'RUB', comment: 'Позвонить перед доставкой',
      items: [{ id: 'line-1', sku: 'SKU-1', sourceSku: 'ART-1', name: 'Товар', packaging: 'коробка', quantity: '2', unitPrice: '122.00', lineTotal: '244.00' }],
    })
  })
})
