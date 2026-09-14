import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the auth boundary so we can exercise backend enforcement without a
// session/server. Proves the closed-catalog invariant lives on the backend.
vi.mock('@/lib/authz', () => ({ getCurrentUser: vi.fn() }))

import { getCurrentUser } from '@/lib/authz'
import { GET } from '@/app/api/catalog/route'

const mockedGetCurrentUser = vi.mocked(getCurrentUser)

describe('GET /api/catalog (closed-catalog enforcement)', () => {
  beforeEach(() => mockedGetCurrentUser.mockReset())

  it('returns 401 for an unauthenticated request (default policy requires auth)', async () => {
    mockedGetCurrentUser.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns 200 for an authenticated user', async () => {
    mockedGetCurrentUser.mockResolvedValue({
      id: 'u1', email: 'b@x.io', name: 'B', role: 'BUYER', status: 'ACTIVE', storeId: 's1', customerId: null, priceGroupId: null,
    })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [] })
  })
})
