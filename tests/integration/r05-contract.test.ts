import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient, type PaymentMethod } from '@prisma/client'
import contract from '../fixtures/onec/r05-contract.json'
import source from '../fixtures/onec/r05-source-sample.json'
import { createInventoryLocation, createPriceBook, upsertFulfillmentChannel } from '@/lib/pricing/setup'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import { importCatalog } from '@/lib/integrations/import-catalog'
import { importPrices } from '@/lib/integrations/import-prices'
import { importAvailability } from '@/lib/integrations/import-availability'
import { resolveVariantPrice } from '@/lib/pricing'
import { availabilityForVariants } from '@/lib/pricing/availability'
import { resolveSellerRequisites } from '@/lib/invoices/requisites'
import { extractVat } from '@/lib/invoices/snapshot'

const db = new PrismaClient()
let storeId: string
const channels = new Map<string, string>()
const variants = new Map<string, string>()

// Replay selected source observations against a configured test contract. The
// explicit mapping below is a fixture boundary, NOT a fix of the ONE_C adapter.
beforeAll(async () => {
  expect(contract.environment).toBe('test')
  expect(contract.externalExportAllowed).toBe(false)
  storeId = (await db.store.create({ data: { slug: `r05-${randomUUID()}`, name: 'R05 isolated contract' } })).id
  const connection = await db.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'R05 local replay' } })
  const book = await createPriceBook({ storeId, code: 'default', name: 'R05', currency: 'RUB', isDefault: true }, db)
  for (const channel of contract.channels) {
    const location = await createInventoryLocation({ storeId, code: channel.inventoryLocationCode, name: channel.inventoryLocationCode }, db)
    await db.externalReference.create({ data: { connectionId: connection.id, entityType: 'location', externalId: channel.warehouseExternalId, entityId: location.id } })
    const seller = contract.sellers[channel.sellerKey as keyof typeof contract.sellers]
    const configured = await upsertFulfillmentChannel({ storeId, code: channel.code, name: channel.code, paymentMethod: channel.paymentMethod as PaymentMethod,
      inventoryLocationId: location.id, priceBookId: book.id, sellerLegalEntity: seller.requisites }, db)
    channels.set(channel.code, configured.id)
  }
  const products = source.samples.map(s => ({ externalId: s.externalId, sku: s.product.article || s.product.barcode || s.product.code, name: s.product.name }))
  const selectedType = contract.channels[0].priceTypeExternalId
  const allowedWarehouses = new Set(contract.channels.map(c => c.warehouseExternalId))
  const prices = source.samples.flatMap(s => s.prices.filter(p => p.ИдТипаЦены === selectedType && p.Валюта === 'RUB' && Number(p.ЦенаЗаЕдиницу) > 0)
    .map(p => ({ externalId: s.externalId, bookCode: 'default', amount: Number(p.ЦенаЗаЕдиницу) })))
  const availability = source.samples.flatMap(s => Object.entries(s.warehouses).filter(([id]) => allowedWarehouses.has(id))
    .map(([locationCode, quantity]) => ({ externalId: s.externalId, locationCode, available: Number(quantity) })))
  const provider = createMockProvider({ products, prices, availability, pageSize: 2 })
  await importCatalog({ storeId, connectionId: connection.id, provider }, db)
  expect(await importPrices({ storeId, connectionId: connection.id, provider }, db)).toEqual({ imported: 4, failed: 0 })
  expect(await importAvailability({ storeId, connectionId: connection.id, provider }, db)).toEqual({ imported: 10, failed: 0 })
  for (const v of await db.productVariant.findMany({ where: { storeId }, select: { id: true, sku: true } })) variants.set(v.sku, v.id)
})

afterAll(async () => {
  try {
    if (storeId) {
      await db.inbox.deleteMany({ where: { storeId } })
      await db.integrationError.deleteMany({ where: { storeId } })
      await db.providerSnapshot.deleteMany({ where: { storeId } })
      await db.store.delete({ where: { id: storeId } })
    }
  } finally { await db.$disconnect() }
})

describe('R05 selected source -> configured channel contract', () => {
  it.each(contract.controls)('$case / $sku: both channels match independently observed expectations', async control => {
    const variantId = variants.get(control.sku)!
    expect(variantId).toBeTruthy()
    for (const channel of contract.channels) {
      const channelId = channels.get(channel.code)!
      const price = await resolveVariantPrice({ storeId, variantId, channelId }, db)
      expect(price?.amount ?? null).toBe(control.expectedPrice === null ? null : Number(control.expectedPrice))
      if (price) expect(price.currency).toBe(channel.currency)
      const amounts = await availabilityForVariants({ variantIds: [variantId], channelId }, db)
      expect(amounts.get(variantId)?.available).toBe(Number(control.expectedAvailable[channel.code as 'rs' | 'nal']))
    }
  })
  it.each(contract.channels)('$code resolves its explicit synthetic seller and tax fixture', async channel => {
    const row = await db.fulfillmentChannel.findUniqueOrThrow({ where: { id: channels.get(channel.code)! } })
    const expected = contract.sellers[channel.sellerKey as keyof typeof contract.sellers]
    const seller = resolveSellerRequisites({ channelSellerLegalEntity: row.sellerLegalEntity, channelInvoiceProfile: row.invoiceProfile, storeSellerRequisites: null })
    expect(expected.synthetic).toBe(true)
    expect(seller).toEqual(expected.requisites)
    for (const control of contract.controls.filter(c => c.expectedPrice !== null)) {
      const vat = extractVat(Number(control.expectedPrice), seller!)
      expect(vat.vatAmount).toBe(Number(control.expectedVatPerUnit))
      expect(vat.vatRate).toBe(22)
    }
  })
  it('keeps zero source price unpriced and excludes stock from the other three warehouses', async () => {
    expect(await db.priceEntry.count({ where: { variant: { storeId } } })).toBe(4)
    expect(await db.stock.count({ where: { variant: { storeId } } })).toBe(10)
    expect(await db.availabilityProjection.count({ where: { variant: { storeId } } })).toBe(10)
    const sample = source.samples.find(s => s.externalId === contract.controls[0].externalId)!
    expect(Number(sample.aggregateQuantity)).toBe(8)
    expect(contract.controls[0].expectedAvailable).toEqual({ rs: '2', nal: '1' })
  })
})
