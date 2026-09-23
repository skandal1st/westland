import { MONEY_POLICY } from '@/lib/money'
import { formatMoney } from '@/lib/money-format'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Prisma, PrismaClient } from '@prisma/client'
import { checkout } from '@/lib/cart/checkout'
import { getCartView, setCartChannel, setCartItem } from '@/lib/cart/cart'
import { submitOrder, reconcileOrder } from '@/lib/orders/orders'
import { readCommercialSnapshot } from '@/lib/orders/commercial-snapshot'
import { issueInvoice, getCurrentInvoice } from '@/lib/invoices/invoices'
import { enqueueOrderExport, runDueOrderExports } from '@/lib/integrations/order-export'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import type { OrderExportPayload } from '@/lib/integrations/provider'
import type { SessionUser } from '@/lib/authz'

const db = new PrismaClient()
let storeId: string, channelId: string, variantId: string, productId: string, deliveryId: string, warehouseId: string, bookId: string, connectionId: string
let user: SessionUser
const seller = { companyName: 'Original seller', inn: '7712345678', vatEnabled: true, vatRate: 22, bank: { name: 'Original bank', account: '40702810900000000001', bik: '044525225', corAccount: '30101810400000000225' } }
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
async function draft() { await setCartChannel(user, channelId); await setCartItem(user, variantId, 2); return checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: randomUUID(), comment: 'Accepted note' }, db) }
async function terms(id: string) { const order = await db.order.findUniqueOrThrow({ where: { id } }); return readCommercialSnapshot(order.commercialSnapshot, order)! }
async function exported(id: string) {
  const remote = createMockProvider({ products: [] })
  const send = vi.fn(remote.submitOrder!.bind(remote))
  remote.submitOrder = send
  await runDueOrderExports({ storeId, orderId: id, resolveProvider: () => remote }, db)
  return { remote, send }
}
async function confirm(id: string, remote = createMockProvider({ products: [] })) {
  await reconcileOrder({ storeId, orderId: id, provider: remote, actor: null }, db)
}
beforeEach(async () => {
  storeId = (await db.store.create({ data: { slug: 'r21-money-' + randomUUID(), name: 'R20 isolated test' } })).id
  await db.appSettings.create({ data: { storeId, invoicePrefix: 'R20-' + storeId.slice(-6), sellerRequisites: seller } })
  bookId = (await db.priceBook.create({ data: { storeId, code: 'original-book', name: 'Original price book', isDefault: true } })).id
  warehouseId = (await db.inventoryLocation.create({ data: { storeId, code: 'original-warehouse', name: 'Original warehouse' } })).id
  channelId = (await db.fulfillmentChannel.create({ data: { storeId, code: 'original-channel', name: 'Original channel', inventoryLocationId: warehouseId, paymentMethod: 'BANK_TRANSFER', priceBookId: bookId } })).id
  productId = (await db.product.create({ data: { storeId, canonicalName: 'Original product', status: 'ACTIVE' } })).id
  variantId = (await db.productVariant.create({ data: { storeId, productId, sku: 'ORIGINAL', sourceSku: 'ARTICLE', packaging: 'box', status: 'ACTIVE' } })).id
  await db.priceEntry.create({ data: { priceBookId: bookId, variantId, amount: 122 } })
  const customer = await db.customer.create({ data: { storeId, displayName: 'Original buyer', legalName: 'Original buyer LLC', inn: '7798765432', kpp: 'original-kpp' } })
  deliveryId = (await db.customerLocation.create({ data: { customerId: customer.id, name: 'Original delivery', address: 'Original street', city: 'Original city' } })).id
  const buyer = await db.user.create({ data: { storeId, customerId: customer.id, email: 'buyer@r20.test', name: 'Buyer', passwordHash: 'test', role: 'BUYER', status: 'ACTIVE' } })
  user = { id: buyer.id, storeId, customerId: customer.id, priceGroupId: null, role: 'BUYER', status: 'ACTIVE', name: buyer.name, email: buyer.email }
  connectionId = (await db.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'R20 source', enabled: true, sourceState: 'ACTIVE', environment: 'TEST' } })).id
})
afterEach(async () => {
  await db.order.deleteMany({ where: { storeId } })
  await db.integrationError.deleteMany({ where: { storeId } })
  await db.store.delete({ where: { id: storeId } })
})


it('cart, checkout, submit, export and invoice agree on fractional line rounding', async () => {
  await db.priceEntry.update({ where: { priceBookId_variantId: { priceBookId: bookId, variantId } }, data: { amount: '0.05' } })
  const other = await db.productVariant.create({ data: { storeId, productId, sku: 'SECOND', isDefault: false } })
  await db.priceEntry.create({ data: { priceBookId: bookId, variantId: other.id, amount: '0.05' } })
  await setCartChannel(user, channelId); await setCartItem(user, variantId, 0.1); await setCartItem(user, other.id, 0.1)
  const cart = await getCartView(user)
  expect(cart.total).toBe('0.02'); expect(cart.lines.map(l => l.lineTotal)).toEqual(['0.01', '0.01'])
  const order = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: randomUUID() }, db)
  expect(order.total.toFixed(2)).toBe('0.02')
  await submitOrder(user, order.id, db) // No phantom repricing challenge.
  const { remote, send } = await exported(order.id); await confirm(order.id, remote)
  expect(send.mock.calls[0][0]).toMatchObject({ total: '0.02', items: [{ quantity: '0.1', unitPrice: '0.05' }, { quantity: '0.1', unitPrice: '0.05' }] })
  const invoice = await issueInvoice({ storeId, orderId: order.id, actor: user }, db)
  expect(invoice.total.toFixed(2)).toBe('0.02')
  expect(invoice.lines.map(l => l.lineTotal.toFixed(2))).toEqual(['0.01', '0.01'])
  expect(invoice.subtotal.add(invoice.vatAmount).toFixed(2)).toBe('0.02')
})

it('keeps full DECIMAL(18,2) precision in quote, payload, snapshot, invoice and formatter', async () => {
  const amount = '9999999999999999.99'
  await db.priceEntry.update({ where: { priceBookId_variantId: { priceBookId: bookId, variantId } }, data: { amount } })
  await setCartChannel(user, channelId); await setCartItem(user, variantId, 1)
  expect((await getCartView(user)).total).toBe(amount)
  const order = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: randomUUID() }, db)
  await submitOrder(user, order.id, db)
  const { remote, send } = await exported(order.id); await confirm(order.id, remote)
  expect(send.mock.calls[0][0].total).toBe(amount)
  expect(send.mock.calls[0][0].items[0].unitPrice).toBe(amount)
  const invoice = await issueInvoice({ storeId, orderId: order.id, actor: user }, db)
  expect(invoice.total.toFixed(2)).toBe(amount)
  expect(invoice.subtotal.add(invoice.vatAmount).toFixed(2)).toBe(amount)
  expect((await terms(order.id)).calculationPolicy).toBe(MONEY_POLICY)
  expect(formatMoney(invoice.total.toFixed(2))).toContain(',99')
})

it('rounds stacked fractional discounts identically before and after checkout', async () => {
  await db.priceEntry.update({ where: { priceBookId_variantId: { priceBookId: bookId, variantId } }, data: { amount: '1.50' } })
  await db.promotion.create({ data: { storeId, name: 'First 5%', value: 5, priority: 10, stackable: false } })
  await db.promotion.create({ data: { storeId, name: 'Next 5%', value: 5, priority: 5, stackable: true } })
  await setCartChannel(user, channelId); await setCartItem(user, variantId, 0.125)
  expect((await getCartView(user)).total).toBe('0.17')
  const order = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: randomUUID() }, db)
  await submitOrder(user, order.id, db)
  expect(await terms(order.id)).toMatchObject({ total: '0.17', tax: { subtotal: '0.14', amount: '0.03' }, lines: [{ unitPrice: '1.36', lineTotal: '0.17', listUnitPrice: '1.50' }] })
})

it('rejects mixed currency atomically at checkout and submit', async () => {
  const other = await db.productVariant.create({ data: { storeId, productId, sku: 'MIXED', isDefault: false } })
  await db.priceEntry.create({ data: { priceBookId: bookId, variantId: other.id, amount: 10 } })
  await setCartChannel(user, channelId); await setCartItem(user, variantId, 1); await setCartItem(user, other.id, 1)
  const mixed = db.$extends({ query: { priceEntry: { async findMany({ args, query }) {
    const rows = await query(args)
    return rows.map((row, index) => ({ ...row, priceBook: { currency: index ? 'USD' : 'RUB' } }))
  } } } }) as unknown as PrismaClient
  await expect(checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: randomUUID() }, mixed)).rejects.toMatchObject({ code: 'MIXED_CURRENCY' })
  expect(await db.order.count({ where: { storeId } })).toBe(0)
  expect((await getCartView(user)).lines).toHaveLength(2)
  const order = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: randomUUID() }, db)
  await expect(submitOrder(user, order.id, mixed)).rejects.toMatchObject({ code: 'MIXED_CURRENCY' })
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).commercialSnapshot).toBeNull()
  expect(await db.orderExport.count({ where: { orderId: order.id } })).toBe(0)
})

it('blocks monetary overflow before consuming cart/counter or freezing a draft', async () => {
  await db.priceEntry.update({ where: { priceBookId_variantId: { priceBookId: bookId, variantId } }, data: { amount: '9000000000000000.00' } })
  await setCartChannel(user, channelId); await setCartItem(user, variantId, 2)
  const before = await db.cart.findUniqueOrThrow({ where: { userId: user.id }, include: { items: true } })
  await expect(checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: randomUUID() }, db)).rejects.toMatchObject({ code: 'INVALID_AMOUNT' })
  expect(await db.cart.findUniqueOrThrow({ where: { userId: user.id }, include: { items: true } })).toEqual(before)
  expect(await db.orderNumberCounter.findUnique({ where: { storeId } })).toBeNull()
})

it('validates R21 arithmetic without reinterpreting historical R20 snapshots', async () => {
  const order = await draft(); await submitOrder(user, order.id, db)
  const accepted = await terms(order.id)
  expect(readCommercialSnapshot({ ...accepted, total: '1.00' }, order)).toBeNull()
  expect(readCommercialSnapshot({ ...accepted, tax: { ...accepted.tax, amount: '0.00' } }, order)).toBeNull()
  const { calculationPolicy, ...historical } = accepted
  expect(calculationPolicy).toBe(MONEY_POLICY)
  expect(readCommercialSnapshot(historical, order)).toEqual(historical)
})

it('accepts a fully discounted zero line but never treats a zero base price as free', async () => {
  await db.promotion.create({ data: { storeId, name: 'Full discount', value: 100 } })
  const order = await draft(); await submitOrder(user, order.id, db)
  expect((await terms(order.id)).total).toBe('0.00')
  await db.priceEntry.update({ where: { priceBookId_variantId: { priceBookId: bookId, variantId } }, data: { amount: 0 } })
  await expect(draft()).rejects.toMatchObject({ code: 'NO_PRICE' })
})

afterAll(async () => { await db.$disconnect() })
