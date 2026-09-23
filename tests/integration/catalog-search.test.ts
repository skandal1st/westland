import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { listCatalog } from '@/lib/catalog/read'
import { createInventoryLocation, createPriceBook, createPriceGroup, upsertFulfillmentChannel } from '@/lib/pricing/setup'

const db = new PrismaClient()
let storeId: string
let otherStoreId: string
let bankId: string
let cashId: string
let groupId: string
let targetId: string
const slug = 'test-r33-catalog'
const at = new Date('2026-09-01T00:00:00Z')
async function cleanup() { await db.store.deleteMany({ where: { slug: { in: [slug, slug + '-other'] } } }) }

beforeAll(async () => {
  await cleanup()
  storeId = (await db.store.create({ data: { slug, name: 'Catalog search' } })).id
  otherStoreId = (await db.store.create({ data: { slug: slug + '-other', name: 'Other store' } })).id
  const category = await db.category.create({ data: { storeId, name: 'Чай', slug: 'tea' } })
  const hidden = await db.category.create({ data: { storeId, name: 'Hidden', slug: 'hidden', hidden: true } })
  const brand = await db.brand.create({ data: { storeId, name: 'Brand', slug: 'brand' } })
  for (let n = 0; n < 63; n++) {
    const target = n === 0
    const product = await db.product.create({ data: {
      id: 'r33-' + String(n).padStart(3, '0'), storeId, status: 'ACTIVE', createdAt: at,
      canonicalName: target ? 'Исходное название' : 'Товар ' + n,
      categoryId: category.id, brandId: brand.id,
      content: { create: { storeId, slug: 'p-' + n, displayName: target ? 'Редкий ЧАЙ' : 'Товар ' + n, imageUrls: [] } },
      variants: { create: { storeId, sku: target ? 'INTERNAL-RARE' : 'SKU-' + n, sourceSku: target ? 'ABC_50%\\part' : 'SRC-' + n } },
    }, include: { variants: true } })
    if (target) targetId = product.variants[0].id
  }
  await db.product.create({ data: { storeId, canonicalName: 'Редкий ЧАЙ без карточки', status: 'ACTIVE' } })
  for (const [suffix, owner, categoryId, status] of [
    ['hidden', storeId, hidden.id, 'ACTIVE'], ['draft', storeId, category.id, 'DRAFT'], ['other', otherStoreId, null, 'ACTIVE'],
  ] as const) {
    await db.product.create({ data: { storeId: owner, categoryId, canonicalName: 'Редкий ЧАЙ', status,
      content: { create: { storeId: owner, slug: suffix, displayName: 'Редкий ЧАЙ', imageUrls: [] } },
      variants: { create: { storeId: owner, sku: suffix, sourceSku: 'ABC_50%\\part' } },
    } })
  }
  const base = await createPriceBook({ storeId, code: 'base', name: 'Base', isDefault: true }, db)
  const vip = await createPriceBook({ storeId, code: 'vip', name: 'VIP' }, db)
  const cash = await createPriceBook({ storeId, code: 'cash', name: 'Cash' }, db)
  groupId = (await createPriceGroup({ storeId, code: 'vip', name: 'VIP', priceBookId: vip.id }, db)).id
  const warehouse = await createInventoryLocation({ storeId, code: 'WH', name: 'Warehouse' }, db)
  bankId = (await upsertFulfillmentChannel({ storeId, code: 'bank', name: 'Bank', paymentMethod: 'BANK_TRANSFER', inventoryLocationId: warehouse.id }, db)).id
  cashId = (await upsertFulfillmentChannel({ storeId, code: 'cash', name: 'Cash', paymentMethod: 'CASH', inventoryLocationId: warehouse.id, priceBookId: cash.id }, db)).id
  for (const [book, amount] of [[base.id, 100], [vip.id, 90], [cash.id, 80]] as const) {
    await db.priceEntry.create({ data: { priceBookId: book, variantId: targetId, amount } })
  }
  for (const [channelId, available] of [[bankId, 4], [cashId, 7]] as const) {
    await db.availabilityProjection.create({ data: { variantId: targetId, fulfillmentChannelId: channelId, availableQuantity: available, sourceUpdatedAt: new Date() } })
  }
})

afterAll(async () => { await cleanup(); await db.$disconnect() })

describe('catalog server search and pagination', () => {
  it('paginates tied timestamps without duplicates, excluding hidden/draft/unrenderable/other-store products from total', async () => {
    const first = await listCatalog({ storeId })
    const second = await listCatalog({ storeId, skip: 50 })
    expect(first.total).toBe(63)
    expect(first.items).toHaveLength(50)
    expect(second.items).toHaveLength(13)
    expect(new Set([...first.items, ...second.items].map(p => p.productId)).size).toBe(63)
    expect(first.items.some(p => p.variantId === targetId)).toBe(false)
    expect(second.items.some(p => p.variantId === targetId)).toBe(true)
    expect((await listCatalog({ storeId })).items.map(p => p.productId)).toEqual(first.items.map(p => p.productId))
  })
  it.each(['редкий чай', 'исходное название', 'internal-rare', 'abc_50%', '%', '_', '\\part'])('finds a late SKU by literal case-insensitive search: %s', async query => {
    const result = await listCatalog({ storeId, query })
    expect(result.total).toBe(1)
    expect(result.items[0].variantId).toBe(targetId)
  })
  it('keeps category/brand constraints and distinguishes a missing match from an out-of-range page', async () => {
    expect((await listCatalog({ storeId, query: 'чай', categorySlug: 'tea', brandSlug: 'brand' })).total).toBe(1)
    expect((await listCatalog({ storeId, query: 'чай', categorySlug: 'missing' })).total).toBe(0)
    expect((await listCatalog({ storeId, query: 'чай', brandSlug: 'missing' })).total).toBe(0)
    expect(await listCatalog({ storeId, query: 'not-present' })).toEqual({ items: [], total: 0 })
    expect(await listCatalog({ storeId, skip: 1000 })).toEqual({ items: [], total: 63 })
  })
  it('preserves buyer pricing and channel-specific availability on search and the second page', async () => {
    const bank = await listCatalog({ storeId, query: 'чай', groupId, channelId: bankId })
    const cash = await listCatalog({ storeId, query: 'чай', groupId, channelId: cashId })
    const page = await listCatalog({ storeId, skip: 50, groupId, channelId: bankId })
    expect(bank.items[0].price?.amountExact).toBe('90.00')
    expect(bank.items[0].availability?.available).toBe(4)
    expect(cash.items[0].price?.amountExact).toBe('80.00')
    expect(cash.items[0].availability?.available).toBe(7)
    expect(page.items.find(p => p.variantId === targetId)?.price?.amountExact).toBe('90.00')
  })
})
