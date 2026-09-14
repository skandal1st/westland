import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { createInventoryLocation, createPriceBook, createPriceGroup, upsertFulfillmentChannel } from '@/lib/pricing/setup'
import { projectChannelAvailability } from '@/lib/pricing/availability'
import { setCartItem, setCartChannel, getCartView, clearCart } from '@/lib/cart/cart'
import { checkout, CheckoutError } from '@/lib/cart/checkout'
import type { SessionUser } from '@/lib/authz'

const prisma = new PrismaClient()
let storeId: string
let channelId: string
let variantId: string
let noPriceVariantId: string
let locationDeliveryId: string
let user: SessionUser

async function cleanup() {
  const store = await prisma.store.findUnique({ where: { slug: 'test-checkout' } })
  if (store) {
    await prisma.order.deleteMany({ where: { storeId: store.id } })
    await prisma.store.delete({ where: { id: store.id } })
  }
}

beforeAll(async () => {
  await cleanup()
  const store = await prisma.store.create({ data: { slug: 'test-checkout', name: 'Test Checkout' } })
  storeId = store.id
  await prisma.appSettings.create({ data: { storeId, invoicePrefix: 'TC' } })
  const book = await createPriceBook({ storeId, code: 'default', name: 'Base', isDefault: true }, prisma)
  await createPriceGroup({ storeId, code: 'retail', name: 'Retail', priceBookId: book.id }, prisma)
  const location = await createInventoryLocation({ storeId, code: 'L1', name: 'WH1' }, prisma)
  channelId = (await upsertFulfillmentChannel({ storeId, code: 'bank', name: 'Bank', paymentMethod: 'BANK_TRANSFER', inventoryLocationId: location.id }, prisma)).id

  const product = await prisma.product.create({ data: { storeId, canonicalName: 'Prod', status: 'ACTIVE' } })
  variantId = (await prisma.productVariant.create({ data: { storeId, productId: product.id, sku: 'SKU-1', packaging: '25 г' } })).id
  noPriceVariantId = (await prisma.productVariant.create({ data: { storeId, productId: product.id, sku: 'SKU-NP', isDefault: false } })).id
  await prisma.priceEntry.create({ data: { priceBookId: book.id, variantId, amount: 590 } })
  await prisma.stock.create({ data: { variantId, locationId: location.id, available: 50 } })
  await prisma.stock.create({ data: { variantId: noPriceVariantId, locationId: location.id, available: 50 } })
  await projectChannelAvailability(channelId, prisma)

  const customer = await prisma.customer.create({ data: { storeId, displayName: 'Buyer', legalName: 'ООО Buyer', inn: '7712345678' } })
  locationDeliveryId = (await prisma.customerLocation.create({ data: { customerId: customer.id, name: 'Точка', address: 'ул. 1', city: 'СПб', isDefault: true } })).id
  const buyer = await prisma.user.create({ data: { storeId, customerId: customer.id, email: 'b@test.local', passwordHash: 'x', name: 'Buyer', role: 'BUYER', status: 'ACTIVE' } })
  user = { id: buyer.id, email: buyer.email, name: buyer.name, role: 'BUYER', status: 'ACTIVE', storeId, customerId: customer.id, priceGroupId: null }
})

beforeEach(async () => {
  await clearCart(user.id)
  await setCartChannel(user, channelId)
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('cart / checkout (integration)', () => {
  it('shows a live cart view with contextual price and availability', async () => {
    await setCartItem(user, variantId, 2)
    const view = await getCartView(user)
    expect(view.lines).toHaveLength(1)
    expect(view.lines[0].unitPrice).toBe(590)
    expect(view.lines[0].lineTotal).toBe(1180)
    expect(view.lines[0].available).toBe(50)
    expect(view.total).toBe(1180)
  })

  it('creates a DRAFT order with server-snapshotted prices and clears the cart', async () => {
    await setCartItem(user, variantId, 2)
    const order = await checkout(user, { deliveryLocationId: locationDeliveryId, idempotencyKey: 'key-draft-1' })
    expect(order.status).toBe('DRAFT')
    expect(Number(order.total)).toBe(1180)
    expect(order.number).toMatch(/^TC-\d{5}$/)
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } })
    expect(items).toHaveLength(1)
    expect(Number(items[0].unitPrice)).toBe(590)
    expect((await getCartView(user)).lines).toHaveLength(0) // cart cleared
  })

  it('reflects a price change between add and checkout (server authoritative)', async () => {
    await setCartItem(user, variantId, 1)
    const book = await prisma.priceBook.findFirstOrThrow({ where: { storeId, isDefault: true } })
    await prisma.priceEntry.update({ where: { priceBookId_variantId: { priceBookId: book.id, variantId } }, data: { amount: 700 } })
    const order = await checkout(user, { deliveryLocationId: locationDeliveryId, idempotencyKey: 'key-pricechange' })
    expect(Number(order.total)).toBe(700)
    await prisma.priceEntry.update({ where: { priceBookId_variantId: { priceBookId: book.id, variantId } }, data: { amount: 590 } })
  })

  it('blocks checkout when stock is insufficient', async () => {
    await setCartItem(user, variantId, 9999)
    await expect(checkout(user, { deliveryLocationId: locationDeliveryId })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' })
  })

  it('blocks checkout when a line has no price', async () => {
    await setCartItem(user, noPriceVariantId, 1)
    await expect(checkout(user, { deliveryLocationId: locationDeliveryId })).rejects.toBeInstanceOf(CheckoutError)
  })

  it('is idempotent for the same idempotencyKey (no duplicate order)', async () => {
    await setCartItem(user, variantId, 1)
    const first = await checkout(user, { deliveryLocationId: locationDeliveryId, idempotencyKey: 'key-idem' })
    // Cart is now empty; the same key returns the existing order rather than erroring.
    const second = await checkout(user, { deliveryLocationId: locationDeliveryId, idempotencyKey: 'key-idem' })
    expect(second.id).toBe(first.id)
    expect(await prisma.order.count({ where: { storeId, idempotencyKey: 'key-idem' } })).toBe(1)
  })
})
