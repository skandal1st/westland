import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import { importCatalog } from '@/lib/integrations/import-catalog'
import { importPrices } from '@/lib/integrations/import-prices'
import { importAvailability } from '@/lib/integrations/import-availability'
import { createInventoryLocation, createPriceBook, createPriceGroup, upsertFulfillmentChannel } from '@/lib/pricing/setup'
import { resolveVariantPrice, resolveBuyerPriceGroupId } from '@/lib/pricing'
import { assignBuyerPriceGroup } from '@/lib/pricing/assignment'
import { listCatalog } from '@/lib/catalog/read'

const prisma = new PrismaClient()
let storeId: string
let connectionId: string
let vipGroupId: string
let retailGroupId: string
let channelBankId: string // location L1, no book -> uses group/default
let channelCashId: string // location L2, book = vip (channel override)
let variantId: string

const products = [{ externalId: 'P1', sku: 'P1', name: 'Prod 1', packaging: '25 г' }]
const prices = [{ externalId: 'P1', amount: 590 }, { externalId: 'P1', bookCode: 'vip', amount: 490 }]
const availability = [{ externalId: 'P1', locationCode: 'L1', available: 48 }, { externalId: 'P1', locationCode: 'L2', available: 11 }]

async function cleanup() {
  const store = await prisma.store.findUnique({ where: { slug: 'test-pricing' } })
  if (store) {
    await prisma.inbox.deleteMany({ where: { storeId: store.id } })
    await prisma.integrationError.deleteMany({ where: { storeId: store.id } })
    await prisma.providerSnapshot.deleteMany({ where: { storeId: store.id } })
    await prisma.store.delete({ where: { id: store.id } })
  }
}

beforeAll(async () => {
  await cleanup()
  const store = await prisma.store.create({ data: { slug: 'test-pricing', name: 'Test Pricing' } })
  storeId = store.id
  const defaultBook = await createPriceBook({ storeId, code: 'default', name: 'Base', isDefault: true }, prisma)
  const vipBook = await createPriceBook({ storeId, code: 'vip', name: 'VIP' }, prisma)
  retailGroupId = (await createPriceGroup({ storeId, code: 'retail', name: 'Retail', priceBookId: defaultBook.id }, prisma)).id
  vipGroupId = (await createPriceGroup({ storeId, code: 'vip', name: 'VIP', priceBookId: vipBook.id }, prisma)).id
  const l1 = await createInventoryLocation({ storeId, code: 'L1', name: 'Warehouse 1' }, prisma)
  const l2 = await createInventoryLocation({ storeId, code: 'L2', name: 'Warehouse 2' }, prisma)
  channelBankId = (await upsertFulfillmentChannel({ storeId, code: 'bank', name: 'Безнал', paymentMethod: 'BANK_TRANSFER', inventoryLocationId: l1.id }, prisma)).id
  channelCashId = (await upsertFulfillmentChannel({ storeId, code: 'cash', name: 'Нал', paymentMethod: 'CASH', inventoryLocationId: l2.id, priceBookId: vipBook.id }, prisma)).id

  const connection = await prisma.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'c' } })
  connectionId = connection.id
  const provider = createMockProvider({ products, prices, availability })
  await importCatalog({ storeId, connectionId, provider }, prisma)
  await importPrices({ storeId, connectionId, provider }, prisma)
  await importAvailability({ storeId, connectionId, provider }, prisma)
  variantId = (await prisma.productVariant.findFirstOrThrow({ where: { storeId, sku: 'P1' } })).id
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('pricing / availability (integration)', () => {
  it('imports prices into the correct books and availability into projections', async () => {
    expect(await prisma.priceEntry.count({ where: { variantId } })).toBe(2)
    expect(await prisma.availabilityProjection.count({ where: { variantId } })).toBe(2)
  })

  it('resolves price by context: default vs group book vs channel override', async () => {
    // No group, bank channel (no book) -> default book 590
    expect((await resolveVariantPrice({ storeId, variantId, channelId: channelBankId }, prisma))?.amount).toBe(590)
    // VIP group on bank channel -> group book 490 (group precedence over default)
    expect((await resolveVariantPrice({ storeId, variantId, groupId: vipGroupId, channelId: channelBankId }, prisma))?.amount).toBe(490)
    // Retail group but cash channel has its own VIP book -> 490 (channel precedence over group)
    expect((await resolveVariantPrice({ storeId, variantId, groupId: retailGroupId, channelId: channelCashId }, prisma))?.amount).toBe(490)
  })

  it('returns null price when there is no entry (not buyable)', async () => {
    const other = await prisma.productVariant.create({ data: { storeId, productId: (await prisma.product.findFirstOrThrow({ where: { storeId } })).id, sku: 'NOPRICE', isDefault: false } })
    expect(await resolveVariantPrice({ storeId, variantId: other.id, channelId: channelBankId }, prisma)).toBeNull()
  })

  it('honours the price date window', async () => {
    const book = await prisma.priceBook.findFirstOrThrow({ where: { storeId, isDefault: true } })
    await prisma.priceEntry.update({ where: { priceBookId_variantId: { priceBookId: book.id, variantId } }, data: { effectiveTo: new Date(Date.now() - 1000) } })
    expect(await resolveVariantPrice({ storeId, variantId, channelId: channelBankId }, prisma)).toBeNull()
    await prisma.priceEntry.update({ where: { priceBookId_variantId: { priceBookId: book.id, variantId } }, data: { effectiveTo: null } })
  })

  it('changes price and availability when the channel changes (via read-model)', async () => {
    const bank = await listCatalog({ storeId, channelId: channelBankId })
    const cash = await listCatalog({ storeId, channelId: channelCashId })
    expect(bank.items[0].price?.amount).toBe(590)
    expect(bank.items[0].availability?.available).toBe(48)
    expect(cash.items[0].price?.amount).toBe(490)
    expect(cash.items[0].availability?.available).toBe(11)
  })

  it('serves availability from the projection without any provider call (outage-safe)', async () => {
    // No provider is involved here at all — the storefront reads the projection.
    const result = await listCatalog({ storeId, channelId: channelBankId })
    expect(result.items[0].availability?.available).toBe(48)
  })

  it('re-imports prices idempotently', async () => {
    const provider = createMockProvider({ products, prices, availability })
    await importPrices({ storeId, connectionId, provider }, prisma)
    expect(await prisma.priceEntry.count({ where: { variantId } })).toBe(2)
  })

  it('resolves the buyer price group from BuyerPriceAssignment', async () => {
    const customer = await prisma.customer.create({ data: { storeId, displayName: 'C', legalName: 'C', inn: '7712345678' } })
    await assignBuyerPriceGroup({ storeId, customerId: customer.id, priceGroupId: vipGroupId, actor: null })
    expect(await resolveBuyerPriceGroupId({ customerId: customer.id, priceGroupId: null }, prisma)).toBe(vipGroupId)
    expect(await prisma.auditEntry.count({ where: { storeId, action: 'PriceGroupChanged' } })).toBe(1)
  })

  it('supports adding a new channel without touching the Order domain', async () => {
    const l3 = await createInventoryLocation({ storeId, code: 'L3', name: 'Warehouse 3' }, prisma)
    const newChannel = await upsertFulfillmentChannel({ storeId, code: 'pickup', name: 'Самовывоз', paymentMethod: 'CASH', inventoryLocationId: l3.id }, prisma)
    // Price/availability resolve for a brand-new channel with no Order model changes.
    await prisma.stock.create({ data: { variantId, locationId: l3.id, available: 7 } })
    const { projectChannelAvailability } = await import('@/lib/pricing/availability')
    await projectChannelAvailability(newChannel.id, prisma)
    const result = await listCatalog({ storeId, channelId: newChannel.id })
    expect(result.items[0].price?.amount).toBe(590) // default book
    expect(result.items[0].availability?.available).toBe(7)
  })
})
