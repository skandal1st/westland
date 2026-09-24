import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), upsert: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/authz', () => ({ requireApiUser: mocks.auth }))
vi.mock('@/lib/audit', () => ({ recordAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({
  prisma: { $transaction: (run: (tx: unknown) => unknown) => run({ appSettings: { upsert: mocks.upsert } }) },
}))

import { PUT } from './route'

const request = (body: unknown) => new Request('http://x/api/staff/settings/palette', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: {
    id: 'admin-1', email: 'admin@example.com', storeId: 'store-1', role: 'ADMIN', status: 'ACTIVE', customerId: null, priceGroupId: null,
  } })
})

describe('store palette settings', () => {
  it('rejects non-admin users before writing settings', async () => {
    mocks.auth.mockResolvedValue({ response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) })
    expect((await PUT(request({ palette: 'blue' }))).status).toBe(403)
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it.each(['unknown', '', null, 42])('rejects an unsupported palette: %s', async palette => {
    expect((await PUT(request({ palette }))).status).toBe(400)
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('stores the palette for the authenticated store and audits the change', async () => {
    const response = await PUT(request({ palette: 'burgundy' }))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ palette: 'burgundy' })
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { storeId: 'store-1' }, update: { palette: 'burgundy' }, create: { storeId: 'store-1', palette: 'burgundy' },
    })
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      storeId: 'store-1', actor: expect.objectContaining({ id: 'admin-1' }), action: 'StorePaletteChanged', metadata: { palette: 'burgundy' },
    }))
  })
})
