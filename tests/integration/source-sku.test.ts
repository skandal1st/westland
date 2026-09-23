import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { afterAll, afterEach, beforeEach, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { applyProductBatch } from '@/lib/catalog/import-batch'
import { applyProductSnapshot } from '@/lib/catalog/import'
import { sourceIdentitySku } from '@/lib/catalog/source-sku'
import { importSourceValues } from '@/lib/integrations/source-import'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import { listCatalog, getProductBySlug } from '@/lib/catalog/read'
import { setCartItem, setCartChannel, getCartView } from '@/lib/cart/cart'
import { checkout } from '@/lib/cart/checkout'
import type { SessionUser } from '@/lib/authz'
const db = new PrismaClient()
let storeId: string, connectionId: string
const row = (externalId: string, sku = '000-ARTICLE') => ({ externalId, sku, name: `Product ${externalId}` })
const apply = (payloads: unknown[]) => db.$transaction(async tx => {
  await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${connectionId} FOR UPDATE`
  return applyProductBatch({ storeId, connectionId, payloads }, tx)
})
async function mapped() {
  const refs = await db.externalReference.findMany({ where: { connectionId, entityType: 'product' } })
  const variants = await db.productVariant.findMany({ where: { storeId } })
  return new Map(refs.map(r => [r.externalId, variants.find(v => v.productId === r.entityId)!]))
}
beforeEach(async () => {
  storeId = (await db.store.create({ data: { slug: randomUUID(), name: 'R16.3' } })).id
  connectionId = (await db.integrationConnection.create({ data: { storeId, name: 'ONE_C', provider: 'ONE_C', enabled: true, sourceState: 'ACTIVE' } })).id
})
afterEach(async () => {
  await db.order.deleteMany({ where: { storeId } }); await db.providerSnapshot.deleteMany({ where: { storeId } }); await db.inbox.deleteMany({ where: { storeId } }); await db.integrationError.deleteMany({ where: { storeId } }); await db.store.delete({ where: { id: storeId } })
})
afterAll(() => db.$disconnect())

it('duplicate articles keep distinct identities, deterministic allocation and stable IDs across reordered replay and article changes', async () => {
  await apply([row('B'), row('A')])
  const before = await mapped(), a = before.get('A')!, b = before.get('B')!
  expect(a).toMatchObject({ sku: '000-ARTICLE', sourceSku: '000-ARTICLE' })
  expect(b).toMatchObject({ sku: sourceIdentitySku(connectionId, 'B'), sourceSku: '000-ARTICLE' })
  expect(a.productId).not.toBe(b.productId)
  await apply([row('A', 'CHANGED'), row('B', 'CHANGED')])
  await apply([row('B', 'CHANGED'), row('A', 'CHANGED')])
  const after = await mapped()
  for (const [id, v] of Array.from(before)) expect(after.get(id)).toMatchObject({ id: v.id, productId: v.productId, sku: v.sku, sourceSku: 'CHANGED' })
  const catalog = await listCatalog({ storeId })
  expect(catalog.items.map(i => i.sourceSku)).toEqual(['CHANGED', 'CHANGED'])
  expect(new Set(catalog.items.map(i => i.sku)).size).toBe(2)
  expect(await getProductBySlug(storeId, catalog.items[0].slug)).toMatchObject({ sourceSku: 'CHANGED' })
  expect(await db.externalReference.findMany({ where: { connectionId, entityType: 'product' }, select: { externalCode: true } })).toEqual([{ externalCode: 'CHANGED' }, { externalCode: 'CHANGED' }])
})

it('single-item ONE_C importer uses the same contract while a pre-existing manual SKU remains untouched', async () => {
  const manual = await db.product.create({ data: { storeId, canonicalName: 'Manual', variants: { create: { storeId, sku: '000-ARTICLE' } } }, include: { variants: true } })
  for (const id of ['A', 'B']) await applyProductSnapshot({ storeId, connectionId, payload: row(id) }, db)
  const before = await mapped()
  await applyProductSnapshot({ storeId, connectionId, payload: row('A', 'REVISED') }, db)
  expect((await mapped()).get('A')).toMatchObject({ id: before.get('A')!.id, sku: sourceIdentitySku(connectionId, 'A'), sourceSku: 'REVISED' })
  expect(await db.productVariant.findUniqueOrThrow({ where: { id: manual.variants[0].id } })).toMatchObject({ sku: '000-ARTICLE', sourceSku: null })
  expect(await db.product.count({ where: { storeId } })).toBe(3)
})

it('occupied derived code fails atomically instead of merging or renaming its owner', async () => {
  await apply([row('A')])
  const reserved = await db.product.create({ data: { storeId, canonicalName: 'Reserved', variants: { create: { storeId, sku: sourceIdentitySku(connectionId, 'B') } } } })
  await expect(apply([row('A', 'NEW'), row('B')])).rejects.toThrow('source_identity_sku_conflict')
  expect((await mapped()).get('A')?.sourceSku).toBe('000-ARTICLE')
  expect(await db.productVariant.count({ where: { productId: reserved.id } })).toBe(1)
  expect(await db.product.count({ where: { storeId } })).toBe(2)
  expect(await db.providerSnapshot.count({ where: { storeId } })).toBe(1)
})

it('migration backfills only unambiguous ONE_C defaults without renaming or overwriting existing articles', async () => {
  for (const id of ['valid', 'foreign', 'ambiguous', 'preserved', 'custom']) await apply([row(id, id)])
  const variants = await mapped()
  await db.productVariant.updateMany({ where: { storeId }, data: { sourceSku: null } })
  await db.productVariant.update({ where: { id: variants.get('preserved')!.id }, data: { sourceSku: 'already-recorded' } })
  await db.productVariant.create({ data: { storeId, productId: variants.get('ambiguous')!.productId, sku: 'second-default' } })
  const custom = await db.integrationConnection.create({ data: { storeId, name: 'Custom', provider: 'CUSTOM' } })
  await db.externalReference.create({ data: { connectionId: custom.id, entityType: 'product', entityId: variants.get('foreign')!.productId, externalId: 'foreign', externalCode: 'wrong' } })
  await db.externalReference.updateMany({ where: { connectionId, externalId: 'custom' }, data: { connectionId: custom.id } })
  const sql = await fs.readFile('prisma/migrations/20260921020000_source_product_codes/migration.sql', 'utf8')
  await db.$executeRawUnsafe(sql.slice(sql.indexOf('UPDATE "ProductVariant"')))
  const result = await db.productVariant.findMany({ where: { storeId } })
  for (const [id, v] of Array.from(variants)) expect(result.find(r => r.id === v.id)).toMatchObject({ sku: id, sourceSku: id === 'valid' ? id : id === 'preserved' ? 'already-recorded' : null })
})

it('identical articles retain independent prices, stock, cart lines and order snapshots through external IDs', async () => {
  await apply([row('A'), row('B')])
  const variants = await mapped(), a = variants.get('A')!, b = variants.get('B')!
  const book = await db.priceBook.create({ data: { storeId, code: 'p', name: 'P', isDefault: true } })
  const location = await db.inventoryLocation.create({ data: { storeId, code: 'w', name: 'W' } })
  const channel = await db.fulfillmentChannel.create({ data: { storeId, code: 'c', name: 'C', inventoryLocationId: location.id, priceBookId: book.id, paymentMethod: 'CASH' } })
  await db.externalReference.createMany({ data: [{ connectionId, entityType: 'priceType', externalId: 'PT', entityId: book.id }, { connectionId, entityType: 'location', externalId: 'WH', entityId: location.id }] })
  const source = await db.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
  const generation = await db.onecGeneration.create({ data: { connectionId, sourceRevision: source.exchangeRevision, digest: 'test', files: [] } })
  const provider = { ...createMockProvider({ provider: 'ONE_C', products: [], prices: [{ externalId: 'A', priceTypeId: 'PT', currency: 'RUB', amount: 11 }, { externalId: 'B', priceTypeId: 'PT', currency: 'RUB', amount: 29 }], availability: [{ externalId: 'A', locationCode: 'WH', available: 3 }, { externalId: 'B', locationCode: 'WH', available: 7 }] }), sourceId: connectionId, generationId: generation.id }
  for (const stream of ['prices', 'availability'] as const) await importSourceValues({ storeId, connectionId, provider }, stream, db)
  expect((await db.priceEntry.findUniqueOrThrow({ where: { priceBookId_variantId: { priceBookId: book.id, variantId: a.id } } })).amount.toString()).toBe('11')
  expect((await db.priceEntry.findUniqueOrThrow({ where: { priceBookId_variantId: { priceBookId: book.id, variantId: b.id } } })).amount.toString()).toBe('29')
  expect((await db.stock.findUniqueOrThrow({ where: { variantId_locationId: { variantId: b.id, locationId: location.id } } })).available.toString()).toBe('7')
  const customer = await db.customer.create({ data: { storeId, displayName: 'Buyer', legalName: 'Buyer', inn: '0000000000' } })
  const buyer = await db.user.create({ data: { storeId, customerId: customer.id, email: 'buyer@test.local', passwordHash: 'test', name: 'Buyer', role: 'BUYER', status: 'ACTIVE' } })
  const user: SessionUser = { id: buyer.id, name: buyer.name, email: buyer.email, role: 'BUYER', status: 'ACTIVE', storeId, customerId: customer.id, priceGroupId: null }
  const delivery = await db.customerLocation.create({ data: { customerId: customer.id, name: 'D', city: 'C', address: 'A' } })
  await setCartChannel(user, channel.id); await setCartItem(user, a.id, 1); await setCartItem(user, b.id, 2)
  const cart = await getCartView(user)
  expect(cart.lines).toHaveLength(2); expect(cart.total).toBe('69.00')
  expect(cart.lines.map(l => l.sourceSku)).toEqual(['000-ARTICLE', '000-ARTICLE'])
  const order = await checkout(user, { deliveryLocationId: delivery.id, idempotencyKey: randomUUID() })
  const items = await db.orderItem.findMany({ where: { orderId: order.id } })
  expect(items).toHaveLength(2); expect(new Set(items.map(i => i.sku)).size).toBe(2)
  await apply([row('A', 'NEW'), row('B', 'NEW')])
  expect(await db.orderItem.findMany({ where: { orderId: order.id } })).toEqual(items)
  expect(items.map(i => i.sourceSku)).toEqual(['000-ARTICLE', '000-ARTICLE'])
})
