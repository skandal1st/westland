import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), update: vi.fn() }))
vi.mock('@/lib/authz', () => ({ requireApiUser: mocks.auth }))
vi.mock('@/lib/pricing/setup', () => {
  class FulfillmentChannelUpdateError extends Error {
    constructor(public code: 'NOT_FOUND' | 'INVALID_REFERENCE' | 'CODE_EXISTS') { super(code) }
  }
  return { FulfillmentChannelUpdateError, updateFulfillmentChannel: mocks.update }
})

import { PUT } from './route'
import { FulfillmentChannelUpdateError } from '@/lib/pricing/setup'

const params = { params: { id: 'channel-1' } }
const valid = {
  code: ' retail ', name: ' Розница ', paymentMethod: 'BANK_TRANSFER',
  inventoryLocationId: 'location-1', priceBookId: null, isActive: true,
}

const request = (body: unknown) => new Request('http://x/api/staff/commerce/channels/channel-1', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'admin-1', email: 'admin@example.com', storeId: 'store-1', role: 'ADMIN' } })
})

describe('sales channel update', () => {
  it('returns authorization failures before validating or changing a channel', async () => {
    mocks.auth.mockResolvedValue({ response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) })

    expect((await PUT(request(valid), params)).status).toBe(403)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it.each([
    { ...valid, paymentMethod: 'CARD' },
    { ...valid, inventoryLocationId: '' },
    { ...valid, isActive: 'yes' },
    { ...valid, extra: true },
  ])('rejects an invalid payload', async body => {
    expect((await PUT(request(body), params)).status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('normalizes fields and scopes the update to the administrator store', async () => {
    mocks.update.mockResolvedValue({ id: 'channel-1', code: 'retail', name: 'Розница' })

    const response = await PUT(request(valid), params)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      storeId: 'store-1', channelId: 'channel-1', code: 'retail', name: 'Розница', actor: expect.objectContaining({ id: 'admin-1' }),
    }))
  })

  it.each([
    ['CODE_EXISTS', 409],
    ['NOT_FOUND', 404],
    ['INVALID_REFERENCE', 400],
  ] as const)('maps %s to %s', async (code, status) => {
    mocks.update.mockRejectedValue(new FulfillmentChannelUpdateError(code))
    expect((await PUT(request(valid), params)).status).toBe(status)
  })
})
