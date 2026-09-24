import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), create: vi.fn() }))
vi.mock('@/lib/authz', () => ({ requireApiUser: mocks.auth }))
vi.mock('@/lib/account/locations', async original => ({
  ...await original<typeof import('@/lib/account/locations')>(),
  createBuyerLocationForStaff: mocks.create,
}))

import { POST } from './route'

const actor = { id: 'staff', storeId: 'trusted', role: 'STAFF' }
const params = { params: { id: 'buyer-1' } }
const request = (body: unknown) => new Request('http://x/api/staff/users/buyer-1/locations/create', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: actor })
  mocks.create.mockResolvedValue({ id: 'point-1' })
})

describe('staff delivery point creation', () => {
  it('allows only staff and admin through the protected capability', async () => {
    mocks.auth.mockResolvedValue({ response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) })

    expect((await POST(request({ name: 'Shop', city: 'City', address: 'Street' }), params)).status).toBe(403)
    expect(mocks.auth).toHaveBeenCalledWith(['STAFF', 'ADMIN'], 'commerce-b2b')
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it.each(['name', 'city', 'address'])('rejects a whitespace-only %s', async field => {
    const response = await POST(request({ name: 'Shop', city: 'City', address: 'Street', [field]: '  ' }), params)

    expect(response.status).toBe(400)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('rejects an address exceeding the integration limit', async () => {
    const response = await POST(request({ name: 'Shop', city: 'X', address: 'x'.repeat(253) }), params)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'address_too_long' })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('creates and grants a point to the selected buyer', async () => {
    const response = await POST(request({ name: ' Shop ', city: ' Moscow ', address: ' Street 1 ', contactName: ' Ivan ', contactPhone: ' +7 ' }), params)

    expect(response.status).toBe(201)
    expect(mocks.create).toHaveBeenCalledWith('buyer-1', actor, { name: 'Shop', city: 'Moscow', address: 'Street 1', contactName: 'Ivan', contactPhone: '+7' })
    await expect(response.json()).resolves.toEqual({ id: 'point-1' })
  })
})
