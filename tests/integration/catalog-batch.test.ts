import { afterAll, afterEach, beforeEach, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { applyProductBatch } from '@/lib/catalog/import-batch'
import { applyProductSnapshot } from '@/lib/catalog/import'
import { projectChannelAvailability } from '@/lib/pricing/availability'
const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] }), other = new PrismaClient()
let queries = 0
db.$on('query', () => { queries++ })
let storeId: string, connectionId: string
beforeEach(async () => {
  storeId = (await db.store.create({ data: { slug: `r16-batch-${randomUUID()}`, name: 'Batch regression' } })).id
  connectionId = (await db.integrationConnection.create({ data: { storeId, provider: 'ONE_C', name: 'Batch', enabled: true, sourceState: 'ACTIVE', environment: 'TEST' } })).id
})
afterEach(async () => { await db.providerSnapshot.deleteMany({ where: { storeId } }); await db.inbox.deleteMany({ where: { storeId } }); await db.store.delete({ where: { id: storeId } }) })
afterAll(async () => { await db.$disconnect(); await other.$disconnect() })
const row = (id: string, sku = id) => ({ externalId: id, sku, name: 'Repeated name', barcode: `bar-${sku}`, categoryExternalId: 'C', categoryName: 'Category', brandExternalId: 'B', brandName: 'Brand' })
const apply = (payloads: unknown[], client = db) => client.$transaction(async tx => {
  await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${connectionId} FOR UPDATE`
  return applyProductBatch({ storeId, connectionId, payloads }, tx)
}, { timeout: 120_000 })
it('cross-batch source article changes preserve internal SKU, every ID, overlay and mapping', async () => {
  const input = Array.from({ length: 1003 }, (_, i) => row(`P${i}`))
  const queryStart = queries
  await apply(input)
  expect(queries - queryStart).toBeLessThan(100)
  const before = await db.productVariant.findMany({ where: { storeId }, orderBy: { id: 'asc' } })
  const first = before.find(v => v.sku === 'P0')!, later = before.find(v => v.sku === 'P501')!
  await db.commerceProductContent.update({ where: { productId: first.productId }, data: { displayName: 'Staff name', slug: 'staff-slug', description: 'Keep', imageUrls: ['staff.png'] } })
  const category = await db.category.findFirstOrThrow({ where: { storeId } })
  await db.category.update({ where: { id: category.id }, data: { name: 'Staff category' } })
  input[0] = row('P0', 'NEW'); input[501] = row('P501', 'P0')
  await apply(input); await apply(input)
  const after = await db.productVariant.findMany({ where: { storeId }, orderBy: { id: 'asc' } })
  expect(after.map(v => [v.id, v.productId])).toEqual(before.map(v => [v.id, v.productId]))
  expect(after.find(v => v.id === first.id)).toMatchObject({ sku: 'P0', sourceSku: 'NEW' }); expect(after.find(v => v.id === later.id)).toMatchObject({ sku: 'P501', sourceSku: 'P0' })
  expect(await db.commerceProductContent.findUniqueOrThrow({ where: { productId: first.productId } })).toMatchObject({ displayName: 'Staff name', slug: 'staff-slug', description: 'Keep', imageUrls: ['staff.png'] })
  expect((await db.category.findUniqueOrThrow({ where: { id: category.id } })).name).toBe('Staff category')
  expect(await db.commerceProductContent.count({ where: { storeId } })).toBe(1003)
  expect(await db.inbox.count({ where: { storeId } })).toBe(1003)
  expect(await db.externalReference.count({ where: { connectionId, entityType: 'product' } })).toBe(1003)
  expect((await db.productIdentifier.findMany({ where: { variantId: first.id } })).map(i => i.value)).toEqual(['bar-NEW'])
}, 60_000)
it('a database error in the second batch rolls back earlier writes and source article changes', async () => {
  await apply([row('existing')])
  const before = await db.productVariant.findFirstOrThrow({ where: { storeId } })
  const input = [row('existing', 'renamed'), ...Array.from({ length: 501 }, (_, i) => row(`X${i}`)), { ...row('zzzz-bad'), unitsPerPack: 2147483648 }]
  await expect(apply(input)).rejects.toThrow()
  expect(await db.productVariant.findMany({ where: { storeId } })).toHaveLength(1)
  expect(await db.productVariant.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ sku: 'existing' })
  expect(await db.providerSnapshot.count({ where: { storeId } })).toBe(1)
  expect(await db.inbox.count({ where: { storeId } })).toBe(1)
  expect(await db.commerceProductContent.count({ where: { storeId } })).toBe(1)
})
it('batch preserves secondary SKU ownership and refuses ambiguous legacy defaults', async () => {
  await apply([row('A')]); const a = await db.productVariant.findFirstOrThrow({ where: { storeId } })
  await db.productVariant.create({ data: { storeId, productId: a.productId, sku: 'secondary', isDefault: false } })
  await apply([row('A', 'secondary')])
  expect(await db.productVariant.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ sku: 'A', sourceSku: 'secondary' })
  expect(await db.productVariant.count({ where: { storeId, sku: 'secondary', isDefault: false } })).toBe(1)
  await db.productVariant.updateMany({ where: { productId: a.productId }, data: { isDefault: true } })
  await expect(apply([row('A', 'new')])).rejects.toMatchObject({ code: 'VARIANT_IDENTITY_AMBIGUOUS' })
  await db.productVariant.updateMany({ where: { productId: a.productId }, data: { isDefault: false } })
  await expect(apply([row('A', 'new')])).rejects.toMatchObject({ code: 'VARIANT_IDENTITY_AMBIGUOUS' })
})
it('a batch and the single-item importer serialize changes to the same existing product', async () => {
  await apply([row('A')]); const before = await db.productVariant.findFirstOrThrow({ where: { storeId } })
  await Promise.all([apply([row('A', 'batch')]), applyProductSnapshot({ storeId, connectionId, payload: row('A', 'single') }, other)])
  const after = await db.productVariant.findMany({ where: { storeId } })
  expect(after).toHaveLength(1); expect(after[0].id).toBe(before.id); expect(after[0].sku).toBe('A'); expect(['batch', 'single']).toContain(after[0].sourceSku)
})
it('competing batches from different sources get separate identities for the same source article', async () => {
  const second = await db.integrationConnection.create({ data: { storeId, provider: 'ONE_C', name: 'Other' } })
  const results = await Promise.allSettled([apply([row('A', 'shared')]), other.$transaction(tx => applyProductBatch({ storeId, connectionId: second.id, payloads: [row('B', 'shared')] }, tx))])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2)
  expect(await db.productVariant.count({ where: { storeId, sku: 'shared' } })).toBe(1)
  expect(await db.product.count({ where: { storeId } })).toBe(2)
})
it('set-based projection preserves IDs, zero/freshness and removes rows after warehouse changes', async () => {
  await apply([row('A'), row('B')]); const variants = await db.productVariant.findMany({ where: { storeId } })
  const a = await db.inventoryLocation.create({ data: { storeId, code: 'a', name: 'A' } }), b = await db.inventoryLocation.create({ data: { storeId, code: 'b', name: 'B' } })
  const channel = await db.fulfillmentChannel.create({ data: { storeId, code: 'c', name: 'C', inventoryLocationId: a.id, paymentMethod: 'CASH' } })
  const at = new Date('2026-09-20T12:00:00Z')
  await db.stock.createMany({ data: variants.map((v, i) => ({ variantId: v.id, locationId: a.id, available: i, sourceUpdatedAt: i ? at : null })) })
  await projectChannelAvailability(channel.id, db)
  const before = await db.availabilityProjection.findMany({ where: { fulfillmentChannelId: channel.id }, orderBy: { id: 'asc' } })
  await projectChannelAvailability(channel.id, db)
  expect((await db.availabilityProjection.findMany({ where: { fulfillmentChannelId: channel.id }, orderBy: { id: 'asc' } })).map(({ updatedAt, ...r }) => r)).toEqual(before.map(({ updatedAt, ...r }) => r))
  await db.fulfillmentChannel.update({ where: { id: channel.id }, data: { inventoryLocationId: b.id } })
  await projectChannelAvailability(channel.id, db)
  expect(await db.availabilityProjection.count({ where: { fulfillmentChannelId: channel.id } })).toBe(0)
})
