import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { createInventoryLocation, createPriceBook, createPriceGroup, upsertFulfillmentChannel } from '@/lib/pricing/setup'
import { projectChannelAvailability } from '@/lib/pricing/availability'
import { setCartItem, setCartChannel } from '@/lib/cart/cart'
import { checkout } from '@/lib/cart/checkout'
import { submitOrder } from '@/lib/orders/orders'
import { issueInvoice, getCurrentInvoice, InvoiceError, sellerOf } from '@/lib/invoices/invoices'
import { renderInvoicePdf } from '@/lib/invoices/pdf'
import type { SessionUser } from '@/lib/authz'

const prisma = new PrismaClient()
let storeId: string
let channelId: string
let bareChannelId: string
let variantId: string
let deliveryId: string
let user: SessionUser
let counter = 0

const seller = { companyName: 'ООО Продавец', inn: '7712345678', kpp: '771201001', bank: { name: 'Банк', bik: '044525225', account: '40702810900000000001' } }

async function cleanup() {
  const store = await prisma.store.findUnique({ where: { slug: 'test-invoice' } })
  if (store) {
    await prisma.order.deleteMany({ where: { storeId: store.id } })
    await prisma.store.delete({ where: { id: store.id } })
  }
}

async function makeSubmittedOrder(channel = channelId) {
  await setCartChannel(user, channel)
  await setCartItem(user, variantId, 2)
  const draft = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: `inv-${counter++}` })
  return submitOrder(user, draft.id, prisma)
}

beforeAll(async () => {
  await cleanup()
  const store = await prisma.store.create({ data: { slug: 'test-invoice', name: 'Test Invoice' } })
  storeId = store.id
  // Store-level requisites deliberately absent: requisites come from the channel.
  await prisma.appSettings.create({ data: { storeId, invoicePrefix: 'TI' } })
  const book = await createPriceBook({ storeId, code: 'default', name: 'Base', isDefault: true }, prisma)
  await createPriceGroup({ storeId, code: 'retail', name: 'Retail', priceBookId: book.id }, prisma)
  const location = await createInventoryLocation({ storeId, code: 'L1', name: 'WH1' }, prisma)
  channelId = (await upsertFulfillmentChannel({
    storeId, code: 'bank', name: 'Bank', paymentMethod: 'BANK_TRANSFER', inventoryLocationId: location.id,
    sellerLegalEntity: seller, invoiceProfile: { vatEnabled: true, vatRate: 20 },
  }, prisma)).id
  // A channel with NO seller requisites (and store has none) — issue must block.
  bareChannelId = (await upsertFulfillmentChannel({ storeId, code: 'cash', name: 'Cash', paymentMethod: 'CASH', inventoryLocationId: location.id }, prisma)).id

  const product = await prisma.product.create({ data: { storeId, canonicalName: 'Prod', status: 'ACTIVE' } })
  variantId = (await prisma.productVariant.create({ data: { storeId, productId: product.id, sku: 'SKU-1', packaging: 'кор' } })).id
  await prisma.priceEntry.create({ data: { priceBookId: book.id, variantId, amount: 100 } })
  await prisma.stock.create({ data: { variantId, locationId: location.id, available: 1000 } })
  await projectChannelAvailability(channelId, prisma)
  await projectChannelAvailability(bareChannelId, prisma)

  const customer = await prisma.customer.create({ data: { storeId, displayName: 'B', legalName: 'ООО Покупатель', inn: '7798765432', kpp: '779801001' } })
  deliveryId = (await prisma.customerLocation.create({ data: { customerId: customer.id, name: 'Склад', address: 'ул 1', city: 'СПб' } })).id
  const buyer = await prisma.user.create({ data: { storeId, customerId: customer.id, email: 'b@t.local', passwordHash: 'x', name: 'B', role: 'BUYER', status: 'ACTIVE' } })
  user = { id: buyer.id, email: buyer.email, name: buyer.name, role: 'BUYER', status: 'ACTIVE', storeId, customerId: customer.id, priceGroupId: null }
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('invoice / snapshot / PDF (integration)', () => {
  it('auto-issues on submit with an immutable snapshot of seller, buyer, VAT and lines', async () => {
    const order = await makeSubmittedOrder()
    const invoice = await getCurrentInvoice({ storeId, orderId: order.id }, prisma)
    expect(invoice).not.toBeNull()
    expect(invoice!.version).toBe(1)
    expect(invoice!.number).toBe(order.number)
    // VAT extracted from gross 200 @ 20%.
    expect(Number(invoice!.total)).toBe(200)
    expect(Number(invoice!.vatAmount)).toBe(33.33)
    expect(Number(invoice!.subtotal)).toBe(166.67)
    // Seller + buyer snapshotted.
    expect(sellerOf(invoice!)?.companyName).toBe('ООО Продавец')
    expect((invoice!.buyerSnapshot as { legalName: string }).legalName).toBe('ООО Покупатель')
    // Lines snapshotted from the order.
    expect(invoice!.lines).toHaveLength(1)
    expect(invoice!.lines[0]).toMatchObject({ sku: 'SKU-1', position: 1 })
    expect(Number(invoice!.lines[0].quantity)).toBe(2)
    expect(Number(invoice!.lines[0].lineTotal)).toBe(200)
  })

  it('changing seller requisites does NOT alter an already-issued invoice', async () => {
    const order = await makeSubmittedOrder()
    const before = await getCurrentInvoice({ storeId, orderId: order.id }, prisma)
    expect(sellerOf(before!)?.companyName).toBe('ООО Продавец')

    // Mutate the channel's seller requisites AFTER issue.
    await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { sellerLegalEntity: { ...seller, companyName: 'ООО Новое Имя' } } })

    const after = await prisma.invoice.findUnique({ where: { id: before!.id } })
    expect((after!.sellerSnapshot as { companyName: string }).companyName).toBe('ООО Продавец')

    // Restore for later tests.
    await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { sellerLegalEntity: seller } })
  })

  it('reissue creates a new version and VOIDs the previous one; the old snapshot is untouched', async () => {
    const order = await makeSubmittedOrder()
    const v1 = await getCurrentInvoice({ storeId, orderId: order.id }, prisma)
    expect(v1!.version).toBe(1)

    await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { sellerLegalEntity: { ...seller, companyName: 'ООО Переоформлено' } } })
    const v2 = await issueInvoice({ storeId, orderId: order.id, actor: user }, prisma)
    expect(v2.version).toBe(2)
    expect(v2.number).toBe(`${order.number}-R2`)
    expect(sellerOf(v2)?.companyName).toBe('ООО Переоформлено')

    // Old row untouched + now VOID; current is v2.
    const old = await prisma.invoice.findUnique({ where: { id: v1!.id } })
    expect(old!.status).toBe('VOID')
    expect((old!.sellerSnapshot as { companyName: string }).companyName).toBe('ООО Продавец')
    const current = await getCurrentInvoice({ storeId, orderId: order.id }, prisma)
    expect(current!.id).toBe(v2.id)

    await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { sellerLegalEntity: seller } })
  })

  it('blocks issue with NO_SELLER_REQUISITES when neither channel nor store has them', async () => {
    const order = await makeSubmittedOrder(bareChannelId)
    // Auto-issue on submit was a no-op (deferred). Explicit issue must reject.
    expect(await getCurrentInvoice({ storeId, orderId: order.id }, prisma)).toBeNull()
    await expect(issueInvoice({ storeId, orderId: order.id, actor: user }, prisma)).rejects.toMatchObject({ code: 'NO_SELLER_REQUISITES' })
    await expect(issueInvoice({ storeId, orderId: order.id, actor: user }, prisma)).rejects.toBeInstanceOf(InvoiceError)
  })

  it('renders the immutable snapshot to a non-empty PDF', async () => {
    const order = await makeSubmittedOrder()
    const invoice = await getCurrentInvoice({ storeId, orderId: order.id }, prisma)
    const pdf = await renderInvoicePdf(invoice!)
    expect(pdf.length).toBeGreaterThan(1000)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})
