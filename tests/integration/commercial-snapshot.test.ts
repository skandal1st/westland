import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Prisma, PrismaClient } from '@prisma/client'
import { checkout } from '@/lib/cart/checkout'
import { setCartChannel, setCartItem } from '@/lib/cart/cart'
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
  storeId = (await db.store.create({ data: { slug: 'r20-' + randomUUID(), name: 'R20 isolated test' } })).id
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

it('captures only at accepted submit, after exact repricing consent, with the source and tax terms', async () => {
  const order = await draft()
  expect(order.commercialSnapshot).toBeNull()
  await db.priceEntry.update({ where: { priceBookId_variantId: { priceBookId: bookId, variantId } }, data: { amount: 244 } })
  const challenge = await submitOrder(user, order.id, db).catch(e => e)
  expect(challenge.code).toBe('PRICE_CHANGED')
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).commercialSnapshot).toBeNull()
  expect(await db.orderExport.count({ where: { orderId: order.id } })).toBe(0)
  await submitOrder(user, order.id, db, { priceConfirmationToken: challenge.quote.token })
  expect(await terms(order.id)).toMatchObject({
    version: 1, orderId: order.id, connectionId, total: '488.00', currency: 'RUB',
    seller, buyer: { id: user.customerId, legalName: 'Original buyer LLC' },
    delivery: { id: deliveryId, address: 'Original street' }, warehouse: { id: warehouseId },
    channel: { id: channelId, paymentMethod: 'BANK_TRANSFER' },
    pricing: { bookId, bookCode: 'original-book' },
    tax: { mode: 'GROSS_INCLUDED', rate: 22, subtotal: '400.00', amount: '88.00' },
    lines: [{ unitPrice: '244.00', listUnitPrice: '244.00', lineTotal: '488.00', quantity: '2', sourceSku: 'ARTICLE' }],
  })
})

it('export and first/reissued invoice preserve all accepted terms after directory and catalog edits', async () => {
  const order = await draft(); await submitOrder(user, order.id, db)
  const accepted = await terms(order.id)
  const other = await db.inventoryLocation.create({ data: { storeId, code: 'new', name: 'New warehouse' } })
  await db.$transaction([
    db.appSettings.update({ where: { storeId }, data: { sellerRequisites: { ...seller, companyName: 'Changed seller', vatRate: 5, bank: { account: 'changed-bank' } } } }),
    db.customer.update({ where: { id: user.customerId! }, data: { legalName: 'Changed buyer', inn: 'changed-inn', kpp: 'changed-kpp' } }),
    db.customerLocation.update({ where: { id: deliveryId }, data: { name: 'Changed delivery', city: 'Changed city', address: 'Changed address' } }),
    db.fulfillmentChannel.update({ where: { id: channelId }, data: { code: 'changed-channel', name: 'Changed channel', paymentMethod: 'CASH', inventoryLocationId: other.id, sellerLegalEntity: { ...seller, companyName: 'New channel seller' }, invoiceProfile: { vatEnabled: false } } }),
    db.inventoryLocation.update({ where: { id: warehouseId }, data: { code: 'changed-warehouse', name: 'Changed warehouse' } }),
    db.priceBook.update({ where: { id: bookId }, data: { code: 'changed-book', name: 'Changed book', currency: 'USD' } }),
    db.priceEntry.update({ where: { priceBookId_variantId: { priceBookId: bookId, variantId } }, data: { amount: 999 } }),
    db.product.update({ where: { id: productId }, data: { canonicalName: 'Changed product', status: 'ARCHIVED' } }),
    db.productVariant.update({ where: { id: variantId }, data: { sku: 'CHANGED', sourceSku: 'CHANGED-ARTICLE', packaging: 'changed', status: 'ARCHIVED' } }),
  ])
  const { remote, send } = await exported(order.id)
  const payload = send.mock.calls[0][0]
  expect(payload.terms).toEqual(accepted)
  expect(payload).toMatchObject({ customer: { legalName: 'Original buyer LLC' }, delivery: { address: 'Original street' }, channel: { code: 'original-channel', paymentMethod: 'BANK_TRANSFER' }, total: '244.00', currency: 'RUB', items: [{ sku: 'ORIGINAL', quantity: '2', unitPrice: '122.00' }] })
  await confirm(order.id, remote)
  const first = await issueInvoice({ storeId, orderId: order.id, actor: user }, db)
  const second = await issueInvoice({ storeId, orderId: order.id, actor: user, expectedVersion: first.version }, db)
  for (const invoice of [first, second]) {
    expect(invoice.sellerSnapshot).toEqual(accepted.seller)
    expect(invoice.buyerSnapshot).toMatchObject({ legalName: 'Original buyer LLC', deliveryAddress: 'Original street' })
    expect(invoice.total.toFixed(2)).toBe('244.00'); expect(invoice.vatAmount.toFixed(2)).toBe('44.00')
    expect(invoice.currency).toBe('RUB')
    expect(invoice.lines[0]).toMatchObject({ sku: 'ARTICLE', name: 'Original product', packaging: 'box' })
    expect(invoice.lines[0].unitPrice.toFixed(2)).toBe('122.00')
  }
  expect(second.version).toBe(2)
  expect((await db.invoice.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('VOID')
  expect(await terms(order.id)).toEqual(accepted)
})

it('retries delivery and repeat submit with the identical snapshot after directory edits', async () => {
  const order = await draft(); await submitOrder(user, order.id, db)
  const accepted = await terms(order.id), payloads: OrderExportPayload[] = []
  const remote = { ...createMockProvider({ products: [] }), submitOrder: async (payload: OrderExportPayload) => {
    payloads.push(payload); if (payloads.length === 1) throw new Error('Lost transport response')
    return { externalId: 'snapshot-retry', acceptedAt: new Date() }
  } }
  await runDueOrderExports({ storeId, orderId: order.id, resolveProvider: () => remote }, db)
  await db.customerLocation.update({ where: { id: deliveryId }, data: { address: 'Changed during outage' } })
  await submitOrder(user, order.id, db)
  await db.orderExport.update({ where: { orderId: order.id }, data: { availableAt: new Date(0) } })
  await runDueOrderExports({ storeId, orderId: order.id, resolveProvider: () => remote }, db)
  expect(payloads).toHaveLength(2); expect(payloads[1]).toEqual(payloads[0]); expect(await terms(order.id)).toEqual(accepted)
})

it('one MVCC view prevents a hybrid buyer/address/seller snapshot during concurrent directory edits', async () => {
  const order = await draft(), entered = gate(), resume = gate()
  let paused = false
  const delayed = db.$extends({ query: { customer: { async findUniqueOrThrow({ args, query }) {
    if (!paused) { paused = true; entered.release(); await resume.promise }
    return query(args)
  } } } }) as unknown as PrismaClient
  const running = submitOrder(user, order.id, delayed)
  try {
    await entered.promise
    await db.$transaction([
      db.customer.update({ where: { id: user.customerId! }, data: { legalName: 'Concurrent buyer' } }),
      db.customerLocation.update({ where: { id: deliveryId }, data: { address: 'Concurrent address' } }),
      db.appSettings.update({ where: { storeId }, data: { sellerRequisites: { ...seller, companyName: 'Concurrent seller' } } }),
    ])
  } finally { resume.release() }
  await running
  expect(await terms(order.id)).toMatchObject({ buyer: { legalName: 'Original buyer LLC' }, delivery: { address: 'Original street' }, seller: { companyName: 'Original seller' } })
})

it('failed enqueue rolls back snapshot, repriced lines and state together', async () => {
  const order = await draft()
  await db.priceEntry.update({ where: { priceBookId_variantId: { priceBookId: bookId, variantId } }, data: { amount: 244 } })
  const challenge = await submitOrder(user, order.id, db).catch(e => e)
  const failing = db.$extends({ query: { orderExport: { async upsert() { throw new Error('Injected enqueue failure') } } } }) as unknown as PrismaClient
  await expect(submitOrder(user, order.id, failing, { priceConfirmationToken: challenge.quote.token })).rejects.toThrow('Injected enqueue failure')
  const after = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } })
  expect(after.status).toBe('DRAFT'); expect(after.commercialSnapshot).toBeNull(); expect(after.total.toFixed(2)).toBe('244.00')
  expect(after.items[0].unitPrice.toFixed(2)).toBe('122.00')
  expect(await db.orderExport.count({ where: { orderId: order.id } })).toBe(0)
  await submitOrder(user, order.id, db, { priceConfirmationToken: challenge.quote.token })
  expect((await terms(order.id)).total).toBe('488.00')
})

it('parallel submit commits exactly one accepted snapshot and export', async () => {
  const order = await draft(), peer = new PrismaClient()
  try {
    const results = await Promise.all([submitOrder(user, order.id, db), submitOrder(user, order.id, peer)])
    expect(results[0].commercialSnapshot).toEqual(results[1].commercialSnapshot)
    expect(await db.orderExport.count({ where: { orderId: order.id } })).toBe(1)
    expect(await db.auditEntry.count({ where: { targetId: order.id, action: 'OrderStatusChanged' } })).toBe(1)
  } finally { await peer.$disconnect() }
})

it('database rejects replacement and erasure of accepted snapshots', async () => {
  const order = await draft(); await submitOrder(user, order.id, db)
  const accepted = await terms(order.id)
  await expect(db.order.update({ where: { id: order.id }, data: { commercialSnapshot: { ...accepted, comment: 'tampered' } } })).rejects.toThrow('order_commercial_snapshot_immutable')
  await expect(db.order.update({ where: { id: order.id }, data: { commercialSnapshot: Prisma.DbNull } })).rejects.toThrow('order_commercial_snapshot_immutable')
  expect(await terms(order.id)).toEqual(accepted)
})

it('legacy orders without snapshots fail export and new invoice without live fallback', async () => {
  const order = await draft()
  await db.order.update({ where: { id: order.id }, data: { status: 'SUBMITTED' } }) // explicit pre-R20 legacy fixture
  await enqueueOrderExport({ storeId, orderId: order.id, connectionId }, db)
  const { send } = await exported(order.id)
  expect(send).not.toHaveBeenCalled()
  expect(await db.orderExport.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({ status: 'FAILED', lastError: 'order_snapshot_required' })
  await db.order.update({ where: { id: order.id }, data: { status: 'CONFIRMED' } })
  await db.orderExport.update({ where: { orderId: order.id }, data: { externalId: 'legacy-id', confirmedAt: new Date() } })
  await expect(issueInvoice({ storeId, orderId: order.id, actor: user }, db)).rejects.toMatchObject({ code: 'SNAPSHOT_REQUIRED' })
  expect(await getCurrentInvoice({ storeId, orderId: order.id }, db)).toBeNull()
})

it('missing seller remains explicitly unconfigured even if live requisites are added later', async () => {
  await db.appSettings.update({ where: { storeId }, data: { sellerRequisites: Prisma.DbNull } })
  const order = await draft(); await submitOrder(user, order.id, db)
  expect(await terms(order.id)).toMatchObject({ seller: null, tax: { mode: 'UNCONFIGURED', amount: null } })
  await db.appSettings.update({ where: { storeId }, data: { sellerRequisites: seller } })
  const { remote } = await exported(order.id); await confirm(order.id, remote)
  await expect(issueInvoice({ storeId, orderId: order.id, actor: user }, db)).rejects.toMatchObject({ code: 'NO_SELLER_REQUISITES' })
})

it('captures channel seller/VAT instead of store fallback and never substitutes a different export source', async () => {
  await db.fulfillmentChannel.update({ where: { id: channelId }, data: { sellerLegalEntity: { ...seller, companyName: 'Channel seller' }, invoiceProfile: { vatEnabled: false } } })
  const order = await draft(); await submitOrder(user, order.id, db)
  expect(await terms(order.id)).toMatchObject({ seller: { companyName: 'Channel seller', vatEnabled: false }, tax: { mode: 'NO_VAT', amount: '0.00', subtotal: '244.00' } })
  const replacement = await db.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'Replacement', enabled: true, sourceState: 'PREPARING', environment: 'TEST' } })
  await db.integrationConnection.update({ where: { id: connectionId }, data: { sourceState: 'PREPARING' } })
  await db.integrationConnection.update({ where: { id: replacement.id }, data: { sourceState: 'ACTIVE' } })
  await db.orderExport.update({ where: { orderId: order.id }, data: { connectionId: replacement.id } })
  const { send } = await exported(order.id)
  expect(send).not.toHaveBeenCalled()
  expect((await db.orderExport.findUniqueOrThrow({ where: { orderId: order.id } })).lastError).toBe('order_snapshot_source_mismatch')
})

afterAll(async () => { await db.$disconnect() })

it('freezes list price and applied promotion provenance even after the promotion is deleted', async () => {
  const promotion = await db.promotion.create({ data: { storeId, name: 'Accepted discount', type: 'PERCENTAGE', value: 10, isActive: true, scope: { variantIds: [variantId] } } })
  const order = await draft(); await submitOrder(user, order.id, db)
  const accepted = await terms(order.id)
  expect(accepted.lines[0]).toMatchObject({ listUnitPrice: '122.00', unitPrice: '109.80', lineTotal: '219.60', promotionIds: [promotion.id] })
  await db.promotion.delete({ where: { id: promotion.id } })
  const { send } = await exported(order.id)
  expect(send.mock.calls[0][0].terms).toEqual(accepted)
})

it('refuses unknown snapshot versions and forbids inventing snapshots for submitted legacy orders', async () => {
  const first = await draft(); await submitOrder(user, first.id, db)
  const accepted = await terms(first.id)
  const legacy = await draft()
  await db.order.update({ where: { id: legacy.id }, data: { status: 'SUBMITTED' } })
  await expect(db.order.update({ where: { id: legacy.id }, data: { commercialSnapshot: { ...accepted, orderId: legacy.id } } })).rejects.toThrow('order_commercial_snapshot_requires_submit')
  const unknown = await draft()
  await db.order.update({ where: { id: unknown.id }, data: { status: 'SUBMITTED', commercialSnapshot: { ...accepted, orderId: unknown.id, version: 999 } } })
  await enqueueOrderExport({ storeId, orderId: unknown.id, connectionId }, db)
  const { send } = await exported(unknown.id)
  expect(send).not.toHaveBeenCalled()
  expect((await db.orderExport.findUniqueOrThrow({ where: { orderId: unknown.id } })).lastError).toBe('order_snapshot_required')
})
