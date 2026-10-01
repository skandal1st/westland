import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: vi.fn(), store: vi.fn(), nav: vi.fn(), settings: vi.fn(), cart: vi.fn(), channel: vi.fn(),
}))
vi.mock('@/lib/authz', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/store', () => ({ getActiveStore: mocks.store }))
vi.mock('@/lib/catalog/read', () => ({ listCatalogNav: mocks.nav }))
vi.mock('@/lib/store-profile', () => ({ loadStoreProfile: () => ({ policies: { catalogRequiresAuth: true } }) }))
vi.mock('@/lib/db', () => ({ prisma: {
  appSettings: { findUnique: mocks.settings }, cart: { findUnique: mocks.cart }, fulfillmentChannel: { findFirst: mocks.channel },
} }))

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({ id: 'buyer-1' })
  mocks.store.mockResolvedValue({ id: 'store-1' })
  mocks.nav.mockResolvedValue({ categories: [], brands: [] })
  mocks.settings.mockResolvedValue({ showOutOfStock: true })
})

describe('GET /api/catalog/nav', () => {
  it('keeps the full navigation when zero-stock products are enabled', async () => {
    expect((await GET(new Request('http://x/api/catalog/nav'))).status).toBe(200)
    expect(mocks.nav).toHaveBeenCalledWith({ storeId: 'store-1', channelId: null, hideOutOfStock: false })
    expect(mocks.cart).not.toHaveBeenCalled()
  })

  it('filters navigation by the selected active channel when zero-stock products are hidden', async () => {
    mocks.settings.mockResolvedValue({ showOutOfStock: false })
    mocks.channel.mockResolvedValueOnce({ id: 'cash' })

    await GET(new Request('http://x/api/catalog/nav?channel=cash'))

    expect(mocks.nav).toHaveBeenCalledWith({ storeId: 'store-1', channelId: 'cash', hideOutOfStock: true })
    expect(mocks.cart).not.toHaveBeenCalled()
  })

  it('uses the saved cart channel, then falls back to the first active channel', async () => {
    mocks.settings.mockResolvedValue({ showOutOfStock: false })
    mocks.cart.mockResolvedValue({ fulfillmentChannelId: 'retired' })
    mocks.channel.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'bank' })

    await GET(new Request('http://x/api/catalog/nav'))

    expect(mocks.nav).toHaveBeenCalledWith({ storeId: 'store-1', channelId: 'bank', hideOutOfStock: true })
  })

  it('returns an empty tree to anonymous users without querying catalog data', async () => {
    mocks.user.mockResolvedValue(null)
    await expect((await GET(new Request('http://x/api/catalog/nav'))).json()).resolves.toEqual({ categories: [], brands: [] })
    expect(mocks.store).not.toHaveBeenCalled()
    expect(mocks.nav).not.toHaveBeenCalled()
  })
})
