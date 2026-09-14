import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { createInventoryLocation, createPriceBook, createPriceGroup, upsertFulfillmentChannel } from '@/lib/pricing/setup'
import { projectChannelAvailability } from '@/lib/pricing/availability'
import { setCartItem, setCartChannel } from '@/lib/cart/cart'
import { checkout } from '@/lib/cart/checkout'
import { submitOrder, transitionOrder, reconcileOrder, OrderError } from '@/lib/orders/orders'
import { runDueOrderExports } from '@/lib/integrations/order-export'
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
  connectionId = (await prisma.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'c', enabled: true } })).id

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
})
