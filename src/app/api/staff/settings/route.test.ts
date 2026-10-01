import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), store: vi.fn(), find: vi.fn(), upsert: vi.fn() }))
vi.mock('@/lib/authz', () => ({ requireApiUser: mocks.auth }))
vi.mock('@/lib/store', () => ({ getActiveStore: mocks.store }))
vi.mock('@/lib/db', () => ({ prisma: { appSettings: { findUnique: mocks.find, upsert: mocks.upsert } } }))

import { GET, PUT } from './route'

const request = (body: unknown) => new Request('http://x/api/staff/settings', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'admin-1', storeId: 'store-1', role: 'ADMIN' } })
  mocks.store.mockResolvedValue({ id: 'store-1' })
})

describe('shared catalog stock visibility setting', () => {
  it('keeps zero-stock products visible by default', async () => {
    mocks.find.mockResolvedValue(null)
    await expect((await GET()).json()).resolves.toEqual({ requisites: {}, showOutOfStock: true })
  })

  it('stores the switch together with the shared store settings', async () => {
    const response = await PUT(request({ showOutOfStock: false }))
    expect(response.status).toBe(200)
    expect(mocks.upsert).toHaveBeenCalledWith({
      where: { storeId: 'store-1' },
      update: { sellerRequisites: {}, showOutOfStock: false },
      create: { storeId: 'store-1', sellerRequisites: {}, showOutOfStock: false },
    })
  })

  it('rejects invalid values and non-admin access', async () => {
    expect((await PUT(request({ showOutOfStock: 'no' }))).status).toBe(400)
    mocks.auth.mockResolvedValue({ response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) })
    expect((await PUT(request({ showOutOfStock: false }))).status).toBe(403)
  })
})
