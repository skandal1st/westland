import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), store: vi.fn(), product: vi.fn(), read: vi.fn(), save: vi.fn() }))
vi.mock('@/lib/authz', () => ({ requireApiUser: mocks.auth }))
vi.mock('@/lib/store', () => ({ getActiveStore: mocks.store }))
vi.mock('@/lib/db', () => ({ prisma: { product: { findFirst: mocks.product } } }))
vi.mock('@/lib/content/assets', () => ({ readImageBody: mocks.read, saveBannerAsset: mocks.save }))

import { POST } from './route'

const params = { params: { id: 'product-1' } }
const request = () => new Request('http://x/api/staff/products/product-1/images', { method: 'POST', body: new Uint8Array([1, 2, 3]) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'staff-1', storeId: 'store-1', role: 'STAFF' } })
  mocks.store.mockResolvedValue({ id: 'store-1' })
  mocks.product.mockResolvedValue({ id: 'product-1' })
  mocks.read.mockResolvedValue(Buffer.from('image'))
  mocks.save.mockResolvedValue('/api/content/assets/123e4567-e89b-12d3-a456-426614174000.webp')
})

describe('product image upload', () => {
  it('requires staff content access before reading the upload', async () => {
    mocks.auth.mockResolvedValue({ response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) })

    expect((await POST(request(), params)).status).toBe(403)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('only accepts products from the active store', async () => {
    mocks.product.mockResolvedValue(null)

    expect((await POST(request(), params)).status).toBe(404)
    expect(mocks.product).toHaveBeenCalledWith({ where: { id: 'product-1', storeId: 'store-1' }, select: { id: true } })
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('stores a validated image and returns its storefront URL', async () => {
    const response = await POST(request(), params)

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ url: '/api/content/assets/123e4567-e89b-12d3-a456-426614174000.webp' })
    expect(mocks.save).toHaveBeenCalledWith('store-1', expect.any(Buffer))
  })

  it.each([['image_too_large', 413], ['invalid_image', 400]] as const)('maps %s to %i', async (message, status) => {
    mocks.read.mockRejectedValue(new Error(message))
    expect((await POST(request(), params)).status).toBe(status)
  })
})
