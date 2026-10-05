import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), update: vi.fn() }))
vi.mock('@/lib/authz', () => ({ requireApiUser: mocks.auth }))
vi.mock('@/lib/catalog/content', () => {
  class ContentError extends Error {
    constructor(public code: 'NOT_FOUND' | 'SLUG_TAKEN') { super(code) }
  }
  return { ContentError, updateProductContent: mocks.update }
})

import { PUT } from './route'

const params = { params: { id: 'product-1' } }
const request = (body: unknown) => new Request('http://x/api/staff/products/product-1/content', {
  method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth.mockResolvedValue({ user: { id: 'staff-1', email: 'staff@example.com', storeId: 'store-1', role: 'STAFF' } })
})

describe('product storefront overlay', () => {
  it('checks staff authorization before changing content', async () => {
    mocks.auth.mockResolvedValue({ response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) })

    expect((await PUT(request({ description: 'Описание' }), params)).status).toBe(403)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('saves supplemental description and attributes with the acting employee', async () => {
    const attributes = { Крепость: 'средняя', Вес: '25 г' }
    const imageUrls = ['/api/content/assets/123e4567-e89b-12d3-a456-426614174000.webp']
    const badges = ['HIT', 'LIMITED']
    mocks.update.mockResolvedValue({ displayName: 'Товар', slug: 'tovar', description: 'Дополнение', imageUrls, attributes, badges })

    const response = await PUT(request({ displayName: ' Товар ', slug: 'tovar', description: 'Дополнение', imageUrls, attributes, badges }), params)

    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith('product-1', {
      displayName: 'Товар', slug: 'tovar', description: 'Дополнение', imageUrls, attributes, badges,
    }, { actor: expect.objectContaining({ id: 'staff-1' }) })
    await expect(response.json()).resolves.toEqual({ content: {
      displayName: 'Товар', slug: 'tovar', description: 'Дополнение', imageUrls, attributes, badges,
    } })
  })

  it('rejects more than thirty attributes', async () => {
    const attributes = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`Поле ${index}`, 'значение']))

    expect((await PUT(request({ attributes }), params)).status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('rejects more than eight images and unsafe image URLs', async () => {
    const image = '/api/content/assets/123e4567-e89b-12d3-a456-426614174000.webp'
    expect((await PUT(request({ imageUrls: Array.from({ length: 9 }, () => image) }), params)).status).toBe(400)
    expect((await PUT(request({ imageUrls: [image, image] }), params)).status).toBe(400)
    expect((await PUT(request({ imageUrls: ['javascript:alert(1)'] }), params)).status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('rejects unknown and duplicate product badges', async () => {
    expect((await PUT(request({ badges: ['HIT', 'UNKNOWN'] }), params)).status).toBe(400)
    expect((await PUT(request({ badges: ['NEW', 'NEW'] }), params)).status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
  })
})
