import { afterAll, beforeEach, afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { applyProductSnapshot } from '@/lib/catalog/import'
import { importCatalog } from '@/lib/integrations/import-catalog'
import { createMockProvider } from '@/lib/integrations/mock-provider'

const db = new PrismaClient()
let storeId: string, connectionId: string
beforeEach(async () => {
  storeId = (await db.store.create({ data: { slug: `r07-${randomUUID()}`, name: 'R07' } })).id
  connectionId = (await db.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'source' } })).id
})
afterEach(async () => {
  await db.order.deleteMany({ where: { storeId } })
  await db.providerSnapshot.deleteMany({ where: { storeId } })
  await db.inbox.deleteMany({ where: { storeId } })
  await db.integrationError.deleteMany({ where: { storeId } })
  await db.store.delete({ where: { id: storeId } })
})
afterAll(() => db.$disconnect())
const apply = (externalId: string, sku: string) => applyProductSnapshot({ storeId, connectionId, payload: { externalId, sku, name: `Name ${sku}`, barcode: `barcode-${sku}` } }, db)

it('SKU rename preserves variant, price, stock, projection, cart and order links; replay stays idempotent', async () => {
  const first = await apply('EXT', 'OLD')
  const location = await db.inventoryLocation.create({ data: { storeId, code: 'wh', name: 'WH' } })
  const channel = await db.fulfillmentChannel.create({ data: { storeId, code: 'rs', name: 'RS', inventoryLocationId: location.id, paymentMethod: 'BANK_TRANSFER' } })
  const book = await db.priceBook.create({ data: { storeId, code: 'default', name: 'Default' } })
  const price = await db.priceEntry.create({ data: { priceBookId: book.id, variantId: first.variantId, amount: 890 } })
  const stock = await db.stock.create({ data: { locationId: location.id, variantId: first.variantId, available: 2 } })
  const projection = await db.availabilityProjection.create({ data: { fulfillmentChannelId: channel.id, variantId: first.variantId, availableQuantity: 2 } })
  const customer = await db.customer.create({ data: { storeId, displayName: 'Buyer', legalName: 'Test', inn: '0000000000' } })
  const user = await db.user.create({ data: { storeId, customerId: customer.id, email: 'r07@test.local', name: 'Buyer', passwordHash: 'fixture', role: 'BUYER' } })
  const delivery = await db.customerLocation.create({ data: { customerId: customer.id, name: 'Test', city: 'Test', address: 'Test' } })
  const cart = await db.cart.create({ data: { storeId, userId: user.id, fulfillmentChannelId: channel.id, items: { create: { variantId: first.variantId, quantity: 1 } } }, include: { items: true } })
  const order = await db.order.create({ data: { storeId, userId: user.id, customerId: customer.id, deliveryLocationId: delivery.id, inventoryLocationId: location.id, fulfillmentChannelId: channel.id, paymentMethod: 'BANK_TRANSFER', number: 'R07', total: 890,
    items: { create: { productId: first.productId, variantId: first.variantId, sku: 'OLD', productName: 'Snapshot', packaging: '', quantity: 1, unitPrice: 890, lineTotal: 890 } } }, include: { items: true } })
  await db.commerceProductContent.update({ where: { productId: first.productId }, data: { displayName: 'Staff overlay' } })
  for (let i = 0; i < 2; i++) expect(await apply('EXT', 'NEW')).toMatchObject({ productId: first.productId, variantId: first.variantId, productCreated: false, contentCreated: false })
  expect(await db.productVariant.count({ where: { productId: first.productId } })).toBe(1)
  expect(await db.productVariant.findUniqueOrThrow({ where: { id: first.variantId } })).toMatchObject({ sku: 'NEW', isDefault: true })
  expect((await db.priceEntry.findUniqueOrThrow({ where: { id: price.id } })).variantId).toBe(first.variantId)
  expect((await db.stock.findUniqueOrThrow({ where: { id: stock.id } })).variantId).toBe(first.variantId)
  expect((await db.availabilityProjection.findUniqueOrThrow({ where: { id: projection.id } })).variantId).toBe(first.variantId)
  expect((await db.cartItem.findUniqueOrThrow({ where: { id: cart.items[0].id } })).variantId).toBe(first.variantId)
  expect(await db.orderItem.findUniqueOrThrow({ where: { id: order.items[0].id } })).toMatchObject({ variantId: first.variantId, sku: 'OLD', productName: 'Snapshot' })
  expect((await db.commerceProductContent.findUniqueOrThrow({ where: { productId: first.productId } })).displayName).toBe('Staff overlay')
  expect((await db.productIdentifier.findMany({ where: { variantId: first.variantId } })).map(i => i.value)).toEqual(['barcode-NEW'])
})

it('occupied SKU rolls back the whole item and the import exposes SKU_CONFLICT without merging', async () => {
  const a = await apply('A', 'A'), b = await apply('B', 'B')
  const provider = createMockProvider({ products: [{ externalId: 'A', sku: 'B', name: 'Should roll back' }] })
  expect(await importCatalog({ storeId, connectionId, provider }, db)).toMatchObject({ imported: 0, failed: 1 })
  expect(await db.productVariant.findUniqueOrThrow({ where: { id: a.variantId } })).toMatchObject({ sku: 'A', productId: a.productId })
  expect(await db.productVariant.findUniqueOrThrow({ where: { id: b.variantId } })).toMatchObject({ sku: 'B', productId: b.productId })
  expect((await db.product.findUniqueOrThrow({ where: { id: a.productId } })).canonicalName).toBe('Name A')
  expect(await db.providerSnapshot.count({ where: { storeId } })).toBe(2)
  expect(await db.integrationError.findFirst({ where: { storeId } })).toMatchObject({ code: 'ITEM_IMPORT_FAILED', message: 'SKU_CONFLICT', context: { externalId: 'A' } })
})

it('existing duplicate defaults are diagnosed, never guessed or silently repaired', async () => {
  const a = await apply('A', 'A')
  await db.productVariant.create({ data: { storeId, productId: a.productId, sku: 'legacy-duplicate', isDefault: true } })
  await expect(apply('A', 'NEW')).rejects.toMatchObject({ code: 'VARIANT_IDENTITY_AMBIGUOUS' })
  expect(await db.productVariant.count({ where: { productId: a.productId } })).toBe(2)
})

it('a non-default variant owning the requested SKU is not promoted or merged', async () => {
  const a = await apply('A', 'A')
  await db.productVariant.create({ data: { storeId, productId: a.productId, sku: 'other', isDefault: false } })
  await expect(apply('A', 'other')).rejects.toMatchObject({ code: 'SKU_CONFLICT' })
})

it('concurrent renames of one product keep exactly one default variant', async () => {
  const a = await apply('A', 'OLD')
  const results = await Promise.all([apply('A', 'NEW-1'), apply('A', 'NEW-2')])
  expect(results.every(r => r.variantId === a.variantId)).toBe(true)
  expect(await db.productVariant.count({ where: { productId: a.productId, isDefault: true } })).toBe(1)
})


it('a product with existing variants but no default requires explicit repair', async () => {
  const a = await apply('A', 'A')
  await db.productVariant.update({ where: { id: a.variantId }, data: { isDefault: false } })
  await expect(apply('A', 'NEW')).rejects.toMatchObject({ code: 'VARIANT_IDENTITY_AMBIGUOUS' })
  expect(await db.productVariant.count({ where: { productId: a.productId } })).toBe(1)
})

it('two different products cannot claim one SKU concurrently', async () => {
  const a = await apply('A', 'A'), b = await apply('B', 'B')
  const results = await Promise.allSettled([apply('A', 'SHARED'), apply('B', 'SHARED')])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult
  expect(failed.reason).toMatchObject({ code: 'SKU_CONFLICT' })
  expect(await db.productVariant.count({ where: { storeId } })).toBe(2)
  expect(await db.productVariant.count({ where: { id: { in: [a.variantId, b.variantId] } } })).toBe(2)
})
