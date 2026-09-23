import { issueInvoice } from '@/lib/invoices/invoices'
import { runWorkerTick } from '@/lib/integrations/worker'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { createInventoryLocation, createPriceBook, createPriceGroup, upsertFulfillmentChannel } from '@/lib/pricing/setup'
import { projectChannelAvailability } from '@/lib/pricing/availability'
import { setCartItem, setCartChannel } from '@/lib/cart/cart'
import { checkout } from '@/lib/cart/checkout'
import { cancelOrder, submitOrder, transitionOrder, reconcileOrder, OrderError } from '@/lib/orders/orders'
import { recoverExpiredWork } from '@/lib/integrations/recovery'
import { enqueueOrderExport, retryOrderExport, runDueOrderExports } from '@/lib/integrations/order-export'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import type { SessionUser } from '@/lib/authz'

const prisma = new PrismaClient()
let storeId: string
let channelId: string
let variantId: string
let deliveryId: string
let connectionId: string
let user: SessionUser
let counter = 0

async function cleanup() {
  const store = await prisma.store.findUnique({ where: { slug: 'test-orders' } })
  if (store) {
    await prisma.order.deleteMany({ where: { storeId: store.id } })
    await prisma.integrationError.deleteMany({ where: { storeId: store.id } })
    await prisma.store.delete({ where: { id: store.id } })
  }
}

async function makeDraft() {
  await setCartChannel(user, channelId)
  await setCartItem(user, variantId, 1)
  return checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: `draft-${counter++}` })
}

const provider = (opts: { failSubmitTimes?: number; orderStatus?: string } = {}) => createMockProvider({ products: [], ...opts })

beforeAll(async () => {
  await cleanup()
  const store = await prisma.store.create({ data: { slug: 'test-orders', name: 'Test Orders' } })
  storeId = store.id
  await prisma.appSettings.create({ data: { storeId, invoicePrefix: 'TO' } })
  const book = await createPriceBook({ storeId, code: 'default', name: 'Base', isDefault: true }, prisma)
  await createPriceGroup({ storeId, code: 'retail', name: 'Retail', priceBookId: book.id }, prisma)
  const location = await createInventoryLocation({ storeId, code: 'L1', name: 'WH1' }, prisma)
  channelId = (await upsertFulfillmentChannel({ storeId, code: 'bank', name: 'Bank', paymentMethod: 'BANK_TRANSFER', inventoryLocationId: location.id }, prisma)).id
  connectionId = (await prisma.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'c', enabled: true, sourceState: 'ACTIVE', environment: 'TEST' } })).id

  const product = await prisma.product.create({ data: { storeId, canonicalName: 'Prod', status: 'ACTIVE' } })
  variantId = (await prisma.productVariant.create({ data: { storeId, productId: product.id, sku: 'SKU-1' } })).id
  await prisma.priceEntry.create({ data: { priceBookId: book.id, variantId, amount: 100 } })
  await prisma.stock.create({ data: { variantId, locationId: location.id, available: 1000 } })
  await projectChannelAvailability(channelId, prisma)

  const customer = await prisma.customer.create({ data: { storeId, displayName: 'B', legalName: 'ООО B', inn: '7712345678' } })
  deliveryId = (await prisma.customerLocation.create({ data: { customerId: customer.id, name: 'Точка', address: 'ул 1', city: 'СПб' } })).id
  const buyer = await prisma.user.create({ data: { storeId, customerId: customer.id, email: 'b@t.local', passwordHash: 'x', name: 'B', role: 'BUYER', status: 'ACTIVE' } })
  user = { id: buyer.id, email: buyer.email, name: buyer.name, role: 'BUYER', status: 'ACTIVE', storeId, customerId: customer.id, priceGroupId: null }
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('orders / provider export (integration)', () => {
  it('submits (DRAFT->SUBMITTED) and exports successfully, keeping business/integration state separate', async () => {
    const draft = await makeDraft()
    expect(draft.status).toBe('DRAFT')
    const submitted = await submitOrder(user, draft.id, prisma)
    expect(submitted.status).toBe('SUBMITTED')

    const results = await runDueOrderExports({ resolveProvider: () => provider() }, prisma)
    expect(results.find((r) => r.orderId === draft.id)?.status).toBe('SUCCESS')

    const exp = await prisma.orderExport.findUnique({ where: { orderId: draft.id } })
    expect(exp?.status).toBe('SUCCESS')
    expect(exp?.externalId).toBeTruthy()
    // Business status unchanged by export.
    expect((await prisma.order.findUnique({ where: { id: draft.id } }))?.status).toBe('SUBMITTED')
    // ExternalReference maps order -> provider id.
    expect(await prisma.externalReference.findFirst({ where: { entityType: 'order', entityId: draft.id } })).not.toBeNull()
  })

  it('double submit is idempotent — one order at the provider', async () => {
    const draft = await makeDraft()
    await submitOrder(user, draft.id, prisma)
    const shared = provider()
    await runDueOrderExports({ resolveProvider: () => shared }, prisma)
    const externalId1 = (await prisma.orderExport.findUnique({ where: { orderId: draft.id } }))?.externalId

    // Re-submit the same order + re-run: no new export, same external id.
    const again = await submitOrder(user, draft.id, prisma)
    expect(again.status).toBe('SUBMITTED')
    await runDueOrderExports({ resolveProvider: () => shared }, prisma)
    const externalId2 = (await prisma.orderExport.findUnique({ where: { orderId: draft.id } }))?.externalId
    expect(externalId2).toBe(externalId1)
    expect(await prisma.orderExport.count({ where: { orderId: draft.id } })).toBe(1)
  })

  it('retries a transient provider failure (RETRYING -> SUCCESS) and survives restart', async () => {
    const draft = await makeDraft()
    await submitOrder(user, draft.id, prisma)

    // First run fails once -> RETRYING, error persisted.
    const failing = provider({ failSubmitTimes: 1 })
    const first = await runDueOrderExports({ resolveProvider: () => failing }, prisma)
    expect(first.find((r) => r.orderId === draft.id)?.status).toBe('RETRYING')
    expect(await prisma.integrationError.count({ where: { storeId, code: 'ORDER_EXPORT_FAILED' } })).toBeGreaterThan(0)

    // Make it due, then "restart" with a fresh provider instance -> SUCCESS, no loss.
    await prisma.orderExport.update({ where: { orderId: draft.id }, data: { availableAt: new Date(Date.now() - 1000) } })
    const second = await runDueOrderExports({ resolveProvider: () => provider() }, prisma)
    expect(second.find((r) => r.orderId === draft.id)?.status).toBe('SUCCESS')
    expect((await prisma.order.findUnique({ where: { id: draft.id } }))?.status).toBe('SUBMITTED') // still SUBMITTED
  })

  it('bounds retries -> FAILED without corrupting the business order', async () => {
    const draft = await makeDraft()
    await submitOrder(user, draft.id, prisma)
    await prisma.orderExport.update({ where: { orderId: draft.id }, data: { maxAttempts: 1 } })
    const results = await runDueOrderExports({ resolveProvider: () => provider({ failSubmitTimes: 5 }) }, prisma)
    expect(results.find((r) => r.orderId === draft.id)?.status).toBe('FAILED')
    const exp = await prisma.orderExport.findUnique({ where: { orderId: draft.id } })
    expect(exp?.status).toBe('FAILED')
    expect(exp?.lastError).toBeTruthy()
    // Business order intact.
    expect((await prisma.order.findUnique({ where: { id: draft.id } }))?.status).toBe('SUBMITTED')
  })

  it('reconciles business status from the provider (SUBMITTED -> CONFIRMED)', async () => {
    const draft = await makeDraft()
    await submitOrder(user, draft.id, prisma)
    await runDueOrderExports({ resolveProvider: () => provider() }, prisma)
    const result = await reconcileOrder({ storeId, orderId: draft.id, provider: provider({ orderStatus: 'CONFIRMED' }), actor: null }, prisma)
    expect(result.changed).toBe(true)
    expect(result.status).toBe('CONFIRMED')
    expect(await prisma.auditEntry.count({ where: { storeId, action: 'OrderStatusChanged', targetId: draft.id } })).toBeGreaterThanOrEqual(2)
  })

  it('rejects invalid business transitions', async () => {
    const draft = await makeDraft()
    await expect(transitionOrder({ storeId, orderId: draft.id, to: 'PROCESSING', actor: null }, prisma)).rejects.toBeInstanceOf(OrderError)
  })
  it('keeps old export bound to its source after another source becomes active', async () => {
    const draft = await makeDraft()
    await submitOrder(user, draft.id, prisma)
    await prisma.integrationConnection.update({ where: { id: connectionId }, data: { sourceState: 'RETIRED', enabled: false } })
    const replacement = await prisma.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'replacement', enabled: true, sourceState: 'ACTIVE', environment: 'PRODUCTION' } })
    try {
      const resolveProvider = vi.fn(() => provider())
      const results = await runDueOrderExports({ resolveProvider }, prisma)
      expect(results.find(r => r.orderId === draft.id)?.status).toBe('FAILED')
      expect(resolveProvider).not.toHaveBeenCalled()
      expect(await prisma.orderExport.findUnique({ where: { orderId: draft.id } })).toMatchObject({ connectionId, status: 'FAILED', lastError: 'source_not_active', attempts: 1 })
      expect((await prisma.order.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('SUBMITTED')
      const next = await makeDraft()
      await submitOrder(user, next.id, prisma)
      expect((await prisma.orderExport.findUniqueOrThrow({ where: { orderId: next.id } })).connectionId).toBe(replacement.id)
      await runDueOrderExports({ resolveProvider }, prisma)
      expect(resolveProvider).toHaveBeenCalledWith(expect.objectContaining({ id: replacement.id }))
    } finally {
      await prisma.integrationConnection.update({ where: { id: replacement.id }, data: { sourceState: 'RETIRED', enabled: false } })
      await prisma.integrationConnection.update({ where: { id: connectionId }, data: { sourceState: 'ACTIVE', enabled: true } })
    }
  })

})

function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
it('R14 concurrent export runners and manual retry submit once', async () => {
  const draft = await makeDraft(); await submitOrder(user, draft.id, prisma)
  const entered = gate(), done = gate(), remote = provider()
  const submit = vi.fn(async (payload: Parameters<NonNullable<typeof remote.submitOrder>>[0]) => { entered.release(); await done.promise; return remote.submitOrder!(payload) })
  const running = runDueOrderExports({ orderId: draft.id, resolveProvider: () => ({ ...remote, submitOrder: submit }) }, prisma)
  try {
    await entered.promise
    expect((await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).attempts).toBe(1)
    await expect(retryOrderExport(draft.id, prisma)).rejects.toMatchObject({ code: 'export_running' })
    expect(await runDueOrderExports({ orderId: draft.id, resolveProvider: () => remote }, prisma)).toEqual([])
  } finally { done.release(); await running }
  expect(submit).toHaveBeenCalledTimes(1)
  expect(await retryOrderExport(draft.id, prisma)).toMatchObject({ status: 'SUCCESS', attempts: 1 })
})
it('R14 crashed PROCESSING consumes its attempt and recovers within the ceiling', async () => {
  const draft = await makeDraft(); await submitOrder(user, draft.id, prisma)
  await prisma.orderExport.update({ where: { orderId: draft.id }, data: { status: 'PROCESSING', attempts: 1, maxAttempts: 2, leaseToken: 'dead', leaseExpiresAt: new Date(0) } })
  await Promise.all([recoverExpiredWork(prisma), recoverExpiredWork(prisma)])
  expect(await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).toMatchObject({ status: 'RETRYING', attempts: 1, leaseToken: null })
  await prisma.orderExport.update({ where: { orderId: draft.id }, data: { status: 'PROCESSING', attempts: 2, leaseToken: 'dead2', leaseExpiresAt: new Date(0) } })
  await recoverExpiredWork(prisma)
  expect(await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).toMatchObject({ status: 'FAILED', attempts: 2 })
  expect(await retryOrderExport(draft.id, prisma)).toMatchObject({ status: 'PENDING', attempts: 2, maxAttempts: 3 })
})
it('R14 a late export acknowledgement cannot overwrite a new lease owner', async () => {
  const draft = await makeDraft(); await submitOrder(user, draft.id, prisma)
  const entered = gate(), done = gate(), remote = provider()
  const running = runDueOrderExports({ orderId: draft.id, resolveProvider: () => ({ ...remote, submitOrder: async () => { entered.release(); await done.promise; return { externalId: 'stale', acceptedAt: new Date() } } }) }, prisma)
  const rejected = expect(running).rejects.toMatchObject({ code: 'execution_lease_lost' })
  await entered.promise
  await prisma.orderExport.update({ where: { orderId: draft.id }, data: { leaseExpiresAt: new Date(0) } })
  await recoverExpiredWork(prisma)
  await retryOrderExport(draft.id, prisma)
  await runDueOrderExports({ orderId: draft.id, resolveProvider: () => remote }, prisma)
  done.release(); await rejected
  const record = await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })
  expect(record.status).toBe('SUCCESS'); expect(record.externalId).not.toBe('stale'); expect(record.attempts).toBe(2)
  expect(await prisma.externalReference.findFirst({ where: { connectionId, externalId: 'stale' } })).toBeNull()
})

it('R14 legacy PROCESSING without a lease counts its interrupted attempt', async () => {
  const draft = await makeDraft(); await submitOrder(user, draft.id, prisma)
  await prisma.orderExport.update({ where: { orderId: draft.id }, data: { status: 'PROCESSING', attempts: 0, maxAttempts: 1 } })
  await recoverExpiredWork(prisma)
  expect(await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).toMatchObject({ status: 'FAILED', attempts: 1, leaseToken: null })
})

it('R15 the independent worker drains a submitted export without another buyer request', async () => {
  const draft = await makeDraft(); await submitOrder(user, draft.id, prisma)
  expect(await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).toMatchObject({ status: 'PENDING', attempts: 0 })
  const remote = provider()
  // Earlier scenarios leave an older manual retry queued; bounded FIFO drains it first.
  for (let i = 0; i < 5; i++) {
    await runWorkerTick({ storeId, exportsFirst: true, resolveProvider: () => remote }, prisma)
    if ((await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).status === 'SUCCESS') break
  }
  expect(await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).toMatchObject({ status: 'SUCCESS', attempts: 1 })
  expect((await prisma.order.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('SUBMITTED')
})

describe('R18 draft policy and concurrent transitions', () => {
  const peer = new PrismaClient()
  afterAll(() => peer.$disconnect())
  const freshExport = (orderId: string) => prisma.orderExport.findUnique({ where: { orderId } })
  async function quoteFor(id: string, token?: string) {
    try { await submitOrder(user, id, prisma, { priceConfirmationToken: token }) } catch (error) {
      expect(error).toBeInstanceOf(OrderError)
      expect((error as OrderError).code).toBe('PRICE_CHANGED')
      return (error as OrderError).quote!
    }
    throw new Error('Expected price confirmation, but draft was submitted')
  }
  async function withPrice(amount: number, work: () => Promise<void>) {
    const price = await prisma.priceEntry.findFirstOrThrow({ where: { variantId } })
    try { await prisma.priceEntry.update({ where: { id: price.id }, data: { amount } }); await work() }
    finally { await prisma.priceEntry.update({ where: { id: price.id }, data: { amount: price.amount } }) }
  }

  it('rejects expired drafts and cannot refresh their TTL by viewing/updating them', async () => {
    const draft = await makeDraft()
    await prisma.order.update({ where: { id: draft.id }, data: { createdAt: new Date(Date.now() - 24 * 3600000), comment: 'new update' } })
    await expect(submitOrder(user, draft.id, prisma)).rejects.toMatchObject({ code: 'DRAFT_EXPIRED' })
    expect(await freshExport(draft.id)).toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT')
    expect((await cancelOrder(user, draft.id, prisma)).order.status).toBe('CANCELLED')
  })

  it('accepts a draft still inside the 24-hour lifetime', async () => {
    const draft = await makeDraft()
    await prisma.order.update({ where: { id: draft.id }, data: { createdAt: new Date(Date.now() - 23 * 3600000) } })
    expect((await submitOrder(user, draft.id, prisma)).status).toBe('SUBMITTED')
  })

  it('never changes the draft amounts or queues export until the buyer confirms a fresh quote', async () => {
    const draft = await makeDraft()
    await withPrice(125, async () => {
      const quote = await quoteFor(draft.id)
      expect(quote).toMatchObject({ previousTotal: '100.00', total: '125.00', currency: 'RUB' })
      expect(await freshExport(draft.id)).toBeNull()
      expect((await prisma.order.findUniqueOrThrow({ where: { id: draft.id } })).total.toString()).toBe('100')
      expect((await quoteFor(draft.id)).token).toBe(quote.token)
      expect((await quoteFor(draft.id, '00000000-0000-4000-8000-000000000000')).token).toBe(quote.token)
      const results = await Promise.all([
        submitOrder(user, draft.id, prisma, { priceConfirmationToken: quote.token }),
        submitOrder(user, draft.id, peer, { priceConfirmationToken: quote.token }),
      ])
      expect(results.map(r => r.status)).toEqual(['SUBMITTED', 'SUBMITTED'])
      expect((await prisma.orderItem.findFirstOrThrow({ where: { orderId: draft.id } })).unitPrice.toString()).toBe('125')
      expect(await prisma.orderExport.count({ where: { orderId: draft.id } })).toBe(1)
      expect(await prisma.auditEntry.count({ where: { targetId: draft.id, action: 'OrderPriceConfirmed' } })).toBe(1)
      expect(await prisma.invoice.count({ where: { orderId: draft.id } })).toBe(0)
    })
  })

  it('invalidates consent if the price changes again, including a decrease', async () => {
    const draft = await makeDraft()
    await withPrice(125, async () => {
      const first = await quoteFor(draft.id)
      await withPrice(90, async () => {
        const second = await quoteFor(draft.id, first.token)
        expect(second.token).not.toBe(first.token)
        expect(second.total).toBe('90.00')
        expect(await freshExport(draft.id)).toBeNull()
        expect((await submitOrder(user, draft.id, prisma, { priceConfirmationToken: second.token })).total.toString()).toBe('90')
      })
    })
  })

  it('cannot use another draft quote token or consent after expiry', async () => {
    const first = await makeDraft(), second = await makeDraft()
    await withPrice(110, async () => {
      const quote = await quoteFor(first.id)
      expect((await quoteFor(second.id, quote.token)).token).not.toBe(quote.token)
      await prisma.order.update({ where: { id: first.id }, data: { createdAt: new Date(Date.now() - 25 * 3600000) } })
      await expect(submitOrder(user, first.id, prisma, { priceConfirmationToken: quote.token })).rejects.toMatchObject({ code: 'DRAFT_EXPIRED' })
      expect(await freshExport(first.id)).toBeNull()
    })
  })

  it('requires confirmation when currency changes even if the numeric amount stays equal', async () => {
    const draft = await makeDraft()
    const price = await prisma.priceEntry.findFirstOrThrow({ where: { variantId } })
    const book = await prisma.priceBook.findUniqueOrThrow({ where: { id: price.priceBookId } })
    try {
      await prisma.priceBook.update({ where: { id: book.id }, data: { currency: 'USD' } })
      const quote = await quoteFor(draft.id)
      expect(quote).toMatchObject({ previousCurrency: 'RUB', currency: 'USD', total: '100.00' })
      expect(await freshExport(draft.id)).toBeNull()
    } finally { await prisma.priceBook.update({ where: { id: book.id }, data: { currency: book.currency } }) }
  })

  it('blocks disabled channels at checkout and again at submit', async () => {
    const draft = await makeDraft()
    await setCartItem(user, variantId, 1)
    try {
      await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { isActive: false } })
      await expect(checkout(user, { deliveryLocationId: deliveryId })).rejects.toMatchObject({ code: 'NO_CHANNEL' })
      await expect(submitOrder(user, draft.id, prisma)).rejects.toMatchObject({ code: 'CHANNEL_UNAVAILABLE' })
      expect(await freshExport(draft.id)).toBeNull()
    } finally { await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { isActive: true } }) }
  })

  it.each(['product', 'variant'] as const)('blocks an archived %s at checkout and at submit', async kind => {
    const draft = await makeDraft()
    await setCartItem(user, variantId, 1)
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })
    const change = (status: 'ACTIVE' | 'ARCHIVED') => kind === 'product'
      ? prisma.product.update({ where: { id: variant.productId }, data: { status } })
      : prisma.productVariant.update({ where: { id: variantId }, data: { status } })
    try {
      await change('ARCHIVED')
      await expect(checkout(user, { deliveryLocationId: deliveryId })).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' })
      await expect(submitOrder(user, draft.id, prisma)).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' })
    } finally { await change('ACTIVE') }
  })

  it('rejects a deleted variant and a changed payment method instead of silently changing the deal', async () => {
    const deleted = await makeDraft()
    await prisma.orderItem.updateMany({ where: { orderId: deleted.id }, data: { variantId: null } })
    await expect(submitOrder(user, deleted.id, prisma)).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' })
    const moved = await makeDraft()
    try {
      await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { paymentMethod: 'CASH' } })
      await expect(submitOrder(user, moved.id, prisma)).rejects.toMatchObject({ code: 'CHANNEL_CHANGED' })
    } finally { await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { paymentMethod: 'BANK_TRANSFER' } }) }
  })

  it('does not expose or submit another buyer/customer/store draft', async () => {
    const draft = await makeDraft()
    for (const other of [{ ...user, id: 'foreign' }, { ...user, storeId: 'foreign' }, { ...user, customerId: 'foreign' }]) {
      await expect(submitOrder(other, draft.id, prisma)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(cancelOrder(other, draft.id, prisma)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(await freshExport(draft.id)).toBeNull()
  })

  it('serializes submit and does not permit a generic status transition to bypass validation', async () => {
    const draft = await makeDraft()
    await expect(transitionOrder({ storeId, orderId: draft.id, to: 'SUBMITTED', actor: null }, prisma)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await Promise.all([submitOrder(user, draft.id, prisma), submitOrder(user, draft.id, peer)])
    expect(await prisma.auditEntry.count({ where: { targetId: draft.id, action: 'OrderStatusChanged' } })).toBe(1)
    expect(await prisma.orderExport.count({ where: { orderId: draft.id } })).toBe(1)
  })

  it('cancels before transmission and forbids enqueue/retry/new export', async () => {
    const draft = await makeDraft(); await submitOrder(user, draft.id, prisma)
    expect(await cancelOrder(user, draft.id, prisma)).toMatchObject({ requested: false, order: { status: 'CANCELLED' } })
    expect(await cancelOrder(user, draft.id, peer)).toMatchObject({ requested: false })
    const remote = provider(), submit = vi.spyOn(remote, 'submitOrder')
    expect(await runDueOrderExports({ orderId: draft.id, resolveProvider: () => remote }, prisma)).toEqual([])
    await expect(retryOrderExport(draft.id, prisma)).rejects.toMatchObject({ code: 'order_not_exportable' })
    await expect(enqueueOrderExport({ storeId, orderId: draft.id, connectionId }, prisma)).rejects.toMatchObject({ code: 'order_not_exportable' })
    expect(submit).not.toHaveBeenCalled()
  })

  it('turns cancellation after the export claim into one manager request, even after timeout', async () => {
    const draft = await makeDraft(); await submitOrder(user, draft.id, prisma)
    const entered = gate(), done = gate()
    const remote = provider()
    const running = runDueOrderExports({ orderId: draft.id, resolveProvider: () => ({ ...remote, submitOrder: async () => { entered.release(); await done.promise; throw new Error('response timeout') } }) }, prisma)
    try {
      await entered.promise
      expect(await cancelOrder(user, draft.id, peer)).toMatchObject({ requested: true, order: { status: 'SUBMITTED' } })
    } finally { done.release(); await running }
    expect(await cancelOrder(user, draft.id, prisma)).toMatchObject({ requested: true, order: { status: 'SUBMITTED' } })
    expect(await prisma.auditEntry.count({ where: { targetId: draft.id, action: 'OrderCancellationRequested' } })).toBe(1)
    expect((await freshExport(draft.id))?.attempts).toBe(1)
  })

  it('concurrent submit/cancel never resurrects a cancelled draft or transmits it', async () => {
    const draft = await makeDraft()
    await Promise.allSettled([submitOrder(user, draft.id, prisma), cancelOrder(user, draft.id, peer)])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('CANCELLED')
    expect(await runDueOrderExports({ orderId: draft.id, resolveProvider: () => provider() }, prisma)).toEqual([])
    await expect(submitOrder(user, draft.id, prisma)).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('allows only one of concurrent confirm/cancel with the same expected status', async () => {
    const draft = await makeDraft(); await submitOrder(user, draft.id, prisma)
    const results = await Promise.allSettled([
      transitionOrder({ storeId, orderId: draft.id, to: 'CONFIRMED', expectedStatus: 'SUBMITTED', actor: null }, prisma),
      transitionOrder({ storeId, orderId: draft.id, to: 'CANCELLED', expectedStatus: 'SUBMITTED', actor: null }, peer),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'STATE_CHANGED' } })
  })

  it('ignores a delayed remote confirmation after cancellation and does not set confirmedAt', async () => {
    const draft = await makeDraft(); await submitOrder(user, draft.id, prisma)
    await runDueOrderExports({ orderId: draft.id, resolveProvider: () => provider() }, prisma)
    const entered = gate(), done = gate()
    const pending = reconcileOrder({ storeId, orderId: draft.id, actor: null, provider: { ...provider(), getOrderStatus: async () => { entered.release(); await done.promise; return { status: 'CONFIRMED', updatedAt: new Date() } } } }, prisma)
    try {
      await entered.promise
      await transitionOrder({ storeId, orderId: draft.id, to: 'CANCELLED', expectedStatus: 'SUBMITTED', actor: null }, peer)
    } finally { done.release() }
    expect(await pending).toEqual({ changed: false, status: 'CANCELLED' })
    expect((await freshExport(draft.id))?.confirmedAt).toBeNull()
  })

  it('does not issue an invoice before ERP confirmation, even after manual confirmation', async () => {
    const draft = await makeDraft(); await submitOrder(user, draft.id, prisma)
    await expect(issueInvoice({ storeId, orderId: draft.id, actor: user }, prisma)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await transitionOrder({ storeId, orderId: draft.id, to: 'CONFIRMED', actor: null }, prisma)
    await expect(issueInvoice({ storeId, orderId: draft.id, actor: user }, prisma)).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })
})

it('R18 a worker holding an old queue snapshot cannot claim after buyer cancellation', async () => {
  const draft = await makeDraft(); await submitOrder(user, draft.id, prisma)
  const listed = gate(), continueClaim = gate()
  const delayed = prisma.$extends({ query: { orderExport: { async findMany({ args, query }) {
    const rows = await query(args); listed.release(); await continueClaim.promise; return rows
  } } } }) as unknown as PrismaClient
  const remote = provider(), submit = vi.spyOn(remote, 'submitOrder')
  const running = runDueOrderExports({ orderId: draft.id, recover: false, resolveProvider: () => remote }, delayed)
  try {
    await listed.promise
    expect(await cancelOrder(user, draft.id, prisma)).toMatchObject({ requested: false, order: { status: 'CANCELLED' } })
  } finally { continueClaim.release() }
  expect(await running).toEqual([])
  expect(submit).not.toHaveBeenCalled()
  expect((await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).attempts).toBe(0)
})

it('R18 records provider confirmation after a manual CONFIRMED status without repeating it', async () => {
  const draft = await makeDraft(); await submitOrder(user, draft.id, prisma)
  await runDueOrderExports({ orderId: draft.id, resolveProvider: () => provider() }, prisma)
  await transitionOrder({ storeId, orderId: draft.id, to: 'CONFIRMED', actor: null }, prisma)
  const request = { storeId, orderId: draft.id, actor: null, provider: provider({ orderStatus: 'CONFIRMED' }) }
  expect(await reconcileOrder(request, prisma)).toEqual({ changed: true, status: 'CONFIRMED' })
  expect((await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).confirmedAt).not.toBeNull()
  expect(await reconcileOrder(request, prisma)).toEqual({ changed: false, status: 'CONFIRMED' })
  expect(await prisma.auditEntry.count({ where: { targetId: draft.id, action: 'OrderProviderConfirmed' } })).toBe(1)
})

describe('R19 ERP decisions for an unreserved request', () => {
  async function exported() {
    const draft = await makeDraft()
    await submitOrder(user, draft.id, prisma)
    await runDueOrderExports({ orderId: draft.id, resolveProvider: () => provider() }, prisma)
    return draft
  }
  const decision = (orderId: string, status: string, customerMessage?: string) => reconcileOrder({
    storeId, orderId, actor: null, provider: createMockProvider({ products: [], orderStatus: status, customerMessage }),
  }, prisma)

  it('transport ACCEPTED and unknown status cannot confirm availability or unlock an invoice', async () => {
    const draft = await exported()
    for (const status of ['ACCEPTED', 'SUCCESS', 'UNKNOWN_UT_STATUS']) {
      expect(await decision(draft.id, status)).toEqual({ changed: false, status: 'SUBMITTED' })
    }
    expect((await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).confirmedAt).toBeNull()
    await expect(issueInvoice({ storeId, orderId: draft.id, actor: user }, prisma)).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('stores a separate refusal with a buyer-safe reason; duplicate delivery cannot resurrect or re-export it', async () => {
    const draft = await exported()
    const stock = await prisma.stock.findFirstOrThrow({ where: { variantId } })
    const projection = await prisma.availabilityProjection.findFirstOrThrow({ where: { variantId } })
    expect(await decision(draft.id, 'REJECTED', 'Нет товара на выбранном складе')).toEqual({ changed: true, status: 'REJECTED' })
    expect(await decision(draft.id, 'REJECTED', 'Нет товара на выбранном складе')).toEqual({ changed: false, status: 'REJECTED' })
    expect(await prisma.order.findUnique({ where: { id: draft.id } })).toMatchObject({ providerDecisionMessage: 'Нет товара на выбранном складе' })
    expect(await decision(draft.id, 'CONFIRMED')).toEqual({ changed: false, status: 'REJECTED' })
    await expect(submitOrder(user, draft.id, prisma)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(retryOrderExport(draft.id, prisma)).rejects.toMatchObject({ code: 'order_not_exportable' })
    await expect(enqueueOrderExport({ storeId, orderId: draft.id, connectionId }, prisma)).rejects.toMatchObject({ code: 'order_not_exportable' })
    expect(await runDueOrderExports({ orderId: draft.id, resolveProvider: () => provider() }, prisma)).toEqual([])
    expect(await cancelOrder(user, draft.id, prisma)).toMatchObject({ requested: false, order: { status: 'REJECTED' } })
    await expect(issueInvoice({ storeId, orderId: draft.id, actor: user }, prisma)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    expect(await prisma.auditEntry.count({ where: { targetId: draft.id, action: 'OrderProviderDecision' } })).toBe(1)
    expect(await prisma.stock.findUnique({ where: { id: stock.id } })).toEqual(stock)
    expect(await prisma.availabilityProjection.findUnique({ where: { id: projection.id } })).toEqual(projection)
  })

  it('keeps partial approval under review without rewriting quantities/prices or authorizing invoices', async () => {
    const draft = await exported()
    const before = await prisma.order.findUniqueOrThrow({ where: { id: draft.id }, include: { items: true } })
    expect(await decision(draft.id, 'PARTIALLY_CONFIRMED', 'Доступна только часть заявки')).toEqual({ changed: true, status: 'REVIEW_REQUIRED' })
    const after = await prisma.order.findUniqueOrThrow({ where: { id: draft.id }, include: { items: true } })
    expect(after.items).toEqual(before.items)
    expect(after.total).toEqual(before.total)
    expect((await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).confirmedAt).toBeNull()
    expect(await decision(draft.id, 'PROCESSING')).toEqual({ changed: false, status: 'REVIEW_REQUIRED' })
    await expect(issueInvoice({ storeId, orderId: draft.id, actor: user }, prisma)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(transitionOrder({ storeId, orderId: draft.id, to: 'CONFIRMED', expectedStatus: 'REVIEW_REQUIRED', actor: user }, prisma)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(retryOrderExport(draft.id, prisma)).rejects.toMatchObject({ code: 'order_not_exportable' })
    // CONFIRMED is the adapter's explicit approval of the ORIGINAL request.
    expect(await decision(draft.id, 'CONFIRMED')).toEqual({ changed: true, status: 'CONFIRMED' })
    expect(await prisma.order.findUnique({ where: { id: draft.id } })).toMatchObject({ providerDecisionMessage: null })
    expect((await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).confirmedAt).not.toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: draft.id }, include: { items: true } })).items).toEqual(before.items)
  })

  it('revokes the confirmation marker when ERP requests review after confirmation', async () => {
    const draft = await exported()
    await decision(draft.id, 'CONFIRMED')
    expect(await decision(draft.id, 'REVIEW_REQUIRED')).toEqual({ changed: true, status: 'REVIEW_REQUIRED' })
    expect((await prisma.orderExport.findUniqueOrThrow({ where: { orderId: draft.id } })).confirmedAt).toBeNull()
    await expect(issueInvoice({ storeId, orderId: draft.id, actor: user }, prisma)).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('bounds public decision text and never stores unknown provider messages as a decision', async () => {
    const draft = await exported()
    await decision(draft.id, 'UNKNOWN', 'internal-error-not-for-buyer')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: draft.id } })).providerDecisionMessage).toBeNull()
    await decision(draft.id, 'REVIEW_REQUIRED', 'x'.repeat(2000))
    expect((await prisma.order.findUniqueOrThrow({ where: { id: draft.id } })).providerDecisionMessage).toHaveLength(1000)
  })

  it('ignores a delayed partial decision after a manager cancelled the request', async () => {
    const draft = await exported(), entered = gate(), done = gate()
    const remote = { ...provider(), getOrderStatus: async () => { entered.release(); await done.promise; return { status: 'PARTIALLY_CONFIRMED', customerMessage: 'late' } } }
    const pending = reconcileOrder({ storeId, orderId: draft.id, actor: null, provider: remote }, prisma)
    try {
      await entered.promise
      await transitionOrder({ storeId, orderId: draft.id, to: 'CANCELLED', expectedStatus: 'SUBMITTED', actor: null }, prisma)
    } finally { done.release() }
    expect(await pending).toEqual({ changed: false, status: 'CANCELLED' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: draft.id } })).providerDecisionMessage).toBeNull()
  })
})
