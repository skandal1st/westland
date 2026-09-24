import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), list: vi.fn(), create: vi.fn() }))
vi.mock('@/lib/authz', () => ({ requireApiUser: mocks.auth }))
vi.mock('@/lib/db', () => ({ prisma: { user: { findMany: mocks.list } } }))
vi.mock('@/lib/staff-accounts', async original => ({
  ...await original<typeof import('@/lib/staff-accounts')>(),
  createStaffAccount: mocks.create,
}))

import { GET, POST } from './route'

const actor = { id: 'admin-1', email: 'owner@example.test', storeId: 'store-1', role: 'ADMIN', status: 'ACTIVE' }
const request = (body: unknown) => new Request('http://x/api/staff/team', { method: 'POST', body: JSON.stringify(body) })
const valid = { name: 'Staff', email: 'staff@example.test', password: 'strong-password-123', role: 'STAFF' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: actor })
  mocks.list.mockResolvedValue([])
  mocks.create.mockResolvedValue({ id: 'staff-1', email: valid.email, name: valid.name, role: valid.role, status: 'ACTIVE', createdAt: new Date() })
})

describe('staff team API', () => {
  it.each([GET, () => POST(request(valid))])('requires an administrator', async handler => {
    mocks.auth.mockResolvedValue({ response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) })

    expect((await handler()).status).toBe(403)
    expect(mocks.auth).toHaveBeenCalledWith(['ADMIN'])
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('lists only staff and admins from the authenticated store', async () => {
    const response = await GET()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ where: { storeId: 'store-1', role: { in: ['STAFF', 'ADMIN'] } } }))
  })

  it.each([
    { ...valid, role: 'BUYER' },
    { ...valid, password: 'short' },
    { ...valid, password: 'я'.repeat(40) },
    { ...valid, email: 'not-email' },
    { ...valid, extra: true },
  ])('rejects invalid privileged account input: %j', async body => {
    expect((await POST(request(body))).status).toBe(400)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('creates staff with normalized fields and never returns the password', async () => {
    const response = await POST(request({ ...valid, name: ' Staff ', email: ' STAFF@Example.test ' }))
    const body = await response.json()

    expect(response.status).toBe(201)
    expect(mocks.create).toHaveBeenCalledWith(actor, valid)
    expect(JSON.stringify(body)).not.toContain(valid.password)
  })
})
