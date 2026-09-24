import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the boundaries so we can exercise backend enforcement + assembly without
// a session/DB. Proves the closed-catalog invariant lives on the backend.
vi.mock('@/lib/authz', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/store', () => ({ getActiveStore: vi.fn() }))
vi.mock('@/lib/catalog/read', () => ({ listCatalog: vi.fn() }))

import { getCurrentUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { listCatalog } from '@/lib/catalog/read'
import { GET } from '@/app/api/catalog/route'

const mockedUser = vi.mocked(getCurrentUser)
const mockedStore = vi.mocked(getActiveStore)
const mockedList = vi.mocked(listCatalog)
const req = () => new Request('http://x/api/catalog')

describe('GET /api/catalog', () => {
  beforeEach(() => {
    mockedUser.mockReset()
    mockedStore.mockReset()
    mockedList.mockReset()
  })

  it('returns 401 for an unauthenticated request (default policy requires auth)', async () => {
    mockedUser.mockResolvedValue(null)
    expect((await GET(req())).status).toBe(401)
  })

  it('returns assembled items for an authenticated user', async () => {
    mockedUser.mockResolvedValue({ id: 'u1', email: 'b@x.io', name: 'B', role: 'BUYER', status: 'ACTIVE', storeId: 's1', customerId: null, priceGroupId: null })
    mockedStore.mockResolvedValue({ id: 's1' } as any)
    mockedList.mockResolvedValue({ items: [{ productId: 'p1', variantId: 'v1', slug: 's', displayName: 'D', description: '', imageUrls: [], attributes: [], sku: 'SKU', packaging: '', categoryId: null, brandId: null, price: { amount: 100, amountExact: '100.00', currency: 'RUB' }, availability: { available: 5, stale: false } }], total: 1 })
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].displayName).toBe('D')
  })

  it('passes search, page, filters and server-derived buyer context to the read model', async () => {
    mockedUser.mockResolvedValue({ id: 'u1', email: 'b@x.io', name: 'B', role: 'BUYER', status: 'ACTIVE', storeId: 's1', customerId: null, priceGroupId: 'vip' })
    mockedStore.mockResolvedValue({ id: 's1' } as any)
    mockedList.mockResolvedValue({ items: [], total: 63 })
    const res = await GET(new Request('http://x/api/catalog?q=%20SKU-55%20&take=50&skip=50&category=tea&brand=brand&channel=bank&groupId=attacker&storeId=attacker'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [], total: 63 })
    expect(mockedList).toHaveBeenCalledWith({ storeId: 's1', query: 'SKU-55', take: 50, skip: 50, categorySlug: 'tea', brandSlug: 'brand', channelId: 'bank', groupId: 'vip' })
  })

  it.each(['take=NaN', 'take=0', 'take=101', 'take=1.5', 'skip=-1', 'skip=Infinity', 'skip=0.1', 'skip=2147483648', 'q=' + 'a'.repeat(201)])('rejects invalid input without querying products: %s', async params => {
    mockedUser.mockResolvedValue({ id: 'u1' } as any)
    const res = await GET(new Request('http://x/api/catalog?' + params))
    expect(res.status).toBe(400)
    expect(mockedList).not.toHaveBeenCalled()
  })
})
