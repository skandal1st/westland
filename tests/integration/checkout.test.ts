import { setBuyerDeliveryPoints } from '@/lib/account/location-access'
import { listBuyerLocations, createBuyerLocation } from '@/lib/account/locations'
import { submitOrder, cancelOrder } from '@/lib/orders/orders'
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
    expect(view.lines[0].unitPrice).toBe('590.00')
    expect(view.lines[0].lineTotal).toBe('1180.00')
    expect(view.lines[0].available).toBe(50)
    expect(view.total).toBe('1180.00')
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

  it('accepts requested quantity above stock without reserving it', async () => {
    await setCartItem(user, variantId, 9999)
    expect((await checkout(user, { deliveryLocationId: locationDeliveryId })).status).toBe('DRAFT')
    expect((await prisma.stock.findFirstOrThrow({ where: { variantId } })).available.toString()).toBe('50')
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


it('snapshots source article separately from the unique internal SKU', async () => {
  await prisma.productVariant.update({ where: { id: variantId }, data: { sourceSku: '001-duplicate' } })
  try {
    await setCartItem(user, variantId, 1)
    expect((await getCartView(user)).lines[0]).toMatchObject({ sku: 'SKU-1', sourceSku: '001-duplicate' })
    const order = await checkout(user, { deliveryLocationId: locationDeliveryId, idempotencyKey: 'source-sku-snapshot' })
    await prisma.productVariant.update({ where: { id: variantId }, data: { sourceSku: 'changed-article' } })
    expect(await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({ sku: 'SKU-1', sourceSku: '001-duplicate', variantId })
  } finally { await prisma.productVariant.update({ where: { id: variantId }, data: { sourceSku: null } }) }
})



it('accepts a request against negative raw stock without reserving or changing the projection', async () => {
  const stock = await prisma.stock.findFirstOrThrow({ where: { variantId } })
  const beforeOrders = await prisma.order.count({ where: { storeId } })
  try {
    await prisma.stock.update({ where: { id: stock.id }, data: { available: -1.2 } })
    await prisma.availabilityProjection.updateMany({ where: { variantId }, data: { availableQuantity: -1.2 } })
    await setCartItem(user, variantId, 1)
    expect((await getCartView(user)).lines[0].available).toBe(0)
    expect((await checkout(user, { deliveryLocationId: locationDeliveryId })).status).toBe('DRAFT')
    expect((await prisma.availabilityProjection.findFirstOrThrow({ where: { variantId } })).availableQuantity.toString()).toBe('-1.2')
    await projectChannelAvailability(channelId, prisma)
    expect((await prisma.availabilityProjection.findFirstOrThrow({ where: { variantId } })).availableQuantity.toString()).toBe('0')
    await setCartItem(user, variantId, 2)
    expect((await checkout(user, { deliveryLocationId: locationDeliveryId })).status).toBe('DRAFT')
    expect((await prisma.stock.findUniqueOrThrow({ where: { id: stock.id } })).available.toString()).toBe('-1.2')
    expect(await prisma.order.count({ where: { storeId } })).toBe(beforeOrders + 2)
  } finally {
    await prisma.stock.update({ where: { id: stock.id }, data: { available: stock.available } })
    await projectChannelAvailability(channelId, prisma)
  }
})

describe('R17 atomic checkout', () => {
  const otherClient = new PrismaClient()
  afterAll(() => otherClient.$disconnect())
  async function request(key: string) {
    const cart = await prisma.cart.findUniqueOrThrow({ where: { userId: user.id } })
    return { deliveryLocationId: locationDeliveryId, cartId: cart.id, cartVersion: cart.version, idempotencyKey: key }
  }

  it('serializes the same key across independent clients', async () => {
    await setCartItem(user, variantId, 2)
    const input = await request('r17-same-key')
    const before = await prisma.order.count({ where: { storeId } })
    const results = await Promise.all([checkout(user, input, prisma), checkout(user, input, otherClient)])
    expect(results[0].id).toBe(results[1].id)
    expect(await prisma.order.count({ where: { storeId } })).toBe(before + 1)
  })

  it('binds different keys to one cart revision and replays aliases after new items arrive', async () => {
    await setCartItem(user, variantId, 2)
    const input = await request('r17-alias-a')
    const alias = { ...input, idempotencyKey: 'r17-alias-b' }
    const results = await Promise.all([checkout(user, input, prisma), checkout(user, alias, otherClient)])
    expect(results[0].id).toBe(results[1].id)
    await setCartItem(user, variantId, 3)
    // A committed response may have been lost; a fresh connection must replay it.
    expect((await checkout(user, alias, otherClient)).id).toBe(results[0].id)
    expect((await getCartView(user)).lines[0].quantity).toBe(3)
    expect(await prisma.checkoutReceipt.count({ where: { orderId: results[0].id } })).toBe(2)
  })

  it('rejects other owners, stores, customers and changed intent without disclosing the order', async () => {
    await setCartItem(user, variantId, 1)
    const input = await request('r17-owned-key')
    await checkout(user, input)
    for (const unauthorized of [{ ...user, id: 'another-user' }, { ...user, storeId: 'another-store' }, { ...user, customerId: 'another-customer' }]) {
      await expect(checkout(unauthorized, input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    }
    await expect(checkout(user, { ...input, comment: 'changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(checkout(user, { ...input, cartVersion: input.cartVersion + 1 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(checkout(user, { ...input, idempotencyKey: 'r17-changed-alias', comment: 'changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect(await prisma.checkoutReceipt.findUnique({ where: { key: 'r17-changed-alias' } })).toBeNull()
  })

  it('protects legacy keys which predate checkout receipts', async () => {
    await setCartItem(user, variantId, 1)
    const input = await request('r17-legacy-key')
    const order = await checkout(user, input)
    await prisma.checkoutReceipt.deleteMany({ where: { orderId: order.id } })
    await prisma.order.update({ where: { id: order.id }, data: { checkoutCartId: null, checkoutCartVersion: null, checkoutIntent: null } })
    expect((await checkout(user, input)).id).toBe(order.id)
    await expect(checkout({ ...user, id: 'other' }, input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('rejects a stale cart revision and leaves its new quantity intact', async () => {
    await setCartItem(user, variantId, 1)
    const input = await request('r17-stale')
    await setCartItem(user, variantId, 4)
    await expect(checkout(user, input)).rejects.toMatchObject({ code: 'CART_CHANGED' })
    expect((await getCartView(user)).lines[0].quantity).toBe(4)
    expect(await prisma.checkoutReceipt.findUnique({ where: { key: input.idempotencyKey } })).toBeNull()
  })

  it('rolls back receipt, counter and cart on validation failure; permits a corrected retry', async () => {
    await setCartItem(user, noPriceVariantId, 1)
    const input = await request('r17-rollback')
    const counter = await prisma.orderNumberCounter.findUnique({ where: { storeId } })
    await expect(checkout(user, input)).rejects.toMatchObject({ code: 'NO_PRICE' })
    expect(await prisma.orderNumberCounter.findUnique({ where: { storeId } })).toEqual(counter)
    expect((await getCartView(user)).version).toBe(input.cartVersion)
    expect(await prisma.checkoutReceipt.findUnique({ where: { key: input.idempotencyKey } })).toBeNull()
    await setCartItem(user, noPriceVariantId, 0)
    await setCartItem(user, variantId, 1)
    expect((await checkout(user, await request(input.idempotencyKey))).status).toBe('DRAFT')
  })

  it('allocates distinct numbers for concurrent buyers and never reuses a deleted number', async () => {
    const buyer = await prisma.user.create({ data: { storeId, customerId: user.customerId, email: 'r17-second@test.local', passwordHash: 'x', name: 'Second', role: 'BUYER', status: 'ACTIVE' } })
    const second = { ...user, id: buyer.id }
    await setCartChannel(second, channelId)
    await setCartItem(second, variantId, 1)
    await setCartItem(user, variantId, 1)
    const orders = await Promise.all([checkout(user, await request('r17-number-a'), prisma), checkout(second, { deliveryLocationId: locationDeliveryId, idempotencyKey: 'r17-number-b' }, otherClient)])
    expect(new Set(orders.map(o => o.number)).size).toBe(2)
    const maximum = Math.max(...orders.map(o => Number(o.number.split('-').at(-1))))
    await prisma.order.deleteMany({ where: { id: { in: orders.map(o => o.id) } } })
    await setCartItem(user, variantId, 1)
    const next = await checkout(user, await request('r17-number-c'))
    expect(Number(next.number.split('-').at(-1))).toBe(maximum + 1)
  })

  it('initializes a missing counter from the largest historical suffix, not row count', async () => {
    await setCartItem(user, variantId, 1)
    const existing = await checkout(user, await request('r17-number-legacy'))
    await prisma.order.update({ where: { id: existing.id }, data: { number: 'OLD-09000' } })
    await prisma.orderNumberCounter.delete({ where: { storeId } })
    await setCartItem(user, variantId, 1)
    const next = await checkout(user, await request('r17-number-seeded'))
    expect(next.number).toBe('TC-09001')
  })

  it('preserves a cart write queued while checkout already holds the cart lock', async () => {
    await setCartItem(user, variantId, 1)
    const input = await request('r17-cart-race')
    let release!: () => void
    let ready!: (pid: number) => void
    const locked = new Promise<number>(resolve => { ready = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const blocker = otherClient.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'order-number:' + storeId}, 0))`
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
      ready(row.pid)
      await gate
    }, { timeout: 15_000 })
    const pid = await locked
    const pending = checkout(user, input, prisma)
    // Observe PostgreSQL blocking, not a sleep-based guess: checkout holds cart,
    // and is waiting for our counter lock before creating its order.
    let mutation: Promise<void> | undefined
    try {
      await expect.poll(async () => {
        const [row] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS waiting`
        return row.waiting
      }, { timeout: 5000, interval: 20 }).toBe(true)
      mutation = setCartItem(user, variantId, 5)
    } finally {
      release()
      await blocker
    }
    const order = await pending
    await mutation
    expect(Number((await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })).quantity)).toBe(1)
    expect((await getCartView(user)).lines[0].quantity).toBe(5)
  })
})

it('rolls back an order write failure after counter allocation', async () => {
  await setCartItem(user, variantId, 50)
  const cart = await prisma.cart.findUniqueOrThrow({ where: { userId: user.id } })
  const counter = await prisma.orderNumberCounter.findUnique({ where: { storeId } })
  const count = await prisma.order.count({ where: { storeId } })
  const failing = prisma.$extends({ query: { order: { async create() { throw new Error('injected order write failure') } } } }) as unknown as PrismaClient
    await expect(checkout(user, { deliveryLocationId: locationDeliveryId, idempotencyKey: 'r17-late-rollback', cartId: cart.id, cartVersion: cart.version }, failing)).rejects.toThrow('injected order write failure')
    expect(await prisma.orderNumberCounter.findUnique({ where: { storeId } })).toEqual(counter)
    expect(await prisma.order.count({ where: { storeId } })).toBe(count)
    expect(await prisma.checkoutReceipt.findUnique({ where: { key: 'r17-late-rollback' } })).toBeNull()
    expect((await getCartView(user)).version).toBe(cart.version)
    expect((await getCartView(user)).lines[0].quantity).toBe(50)
})

it('creates the first cart safely under concurrent add/channel requests', async () => {
  const buyer = await prisma.user.create({ data: { storeId, customerId: user.customerId, email: 'r17-first-cart@test.local', passwordHash: 'x', name: 'First cart', role: 'BUYER', status: 'ACTIVE' } })
  const fresh = { ...user, id: buyer.id }
  await Promise.all([setCartChannel(fresh, channelId), setCartItem(fresh, variantId, 2), setCartItem(fresh, noPriceVariantId, 1)])
  const view = await getCartView(fresh)
  expect(view.channelId).toBe(channelId)
  expect(view.lines).toHaveLength(2)
  expect(view.version).toBe(3)
})

it.each(['missing', 'stale', 'zero'] as const)('R19 accepts %s availability without modifying it', async kind => {
  const projection = await prisma.availabilityProjection.findFirstOrThrow({ where: { variantId, fulfillmentChannelId: channelId } })
  try {
    if (kind === 'missing') await prisma.availabilityProjection.delete({ where: { id: projection.id } })
    else await prisma.availabilityProjection.update({ where: { id: projection.id }, data: kind === 'zero' ? { availableQuantity: 0 } : { sourceUpdatedAt: new Date(0) } })
    const before = await prisma.availabilityProjection.findFirst({ where: { variantId, fulfillmentChannelId: channelId } })
    const stock = await prisma.stock.findFirstOrThrow({ where: { variantId } })
    await setCartItem(user, variantId, 60)
    const order = await checkout(user, { deliveryLocationId: locationDeliveryId })
    await submitOrder(user, order.id, prisma)
    expect(await prisma.availabilityProjection.findFirst({ where: { variantId, fulfillmentChannelId: channelId } })).toEqual(before)
    expect(await prisma.stock.findUnique({ where: { id: stock.id } })).toEqual(stock)
  } finally { await projectChannelAvailability(channelId, prisma) }
})

it('R19 accepts concurrent demand above cached stock without a local reservation, including cancellation', async () => {
  const buyer = await prisma.user.create({ data: { storeId, customerId: user.customerId, email: 'r19-second@test.local', passwordHash: 'x', name: 'Second', role: 'BUYER', status: 'ACTIVE' } })
  const second = { ...user, id: buyer.id }
  const peer = new PrismaClient()
  const stock = await prisma.stock.findFirstOrThrow({ where: { variantId } })
  const projection = await prisma.availabilityProjection.findFirstOrThrow({ where: { variantId } })
  try {
    await setCartChannel(second, channelId)
    await Promise.all([setCartItem(second, variantId, 40), setCartItem(user, variantId, 40)])
    const orders = await Promise.all([
      checkout(user, { deliveryLocationId: locationDeliveryId }, prisma),
      checkout(second, { deliveryLocationId: locationDeliveryId }, peer),
    ])
    await Promise.all([submitOrder(user, orders[0].id, prisma), submitOrder(second, orders[1].id, peer)])
    expect(orders[0].id).not.toBe(orders[1].id)
    await cancelOrder(user, orders[0].id, prisma)
    expect(await prisma.stock.findUnique({ where: { id: stock.id } })).toEqual(stock)
    expect(await prisma.availabilityProjection.findUnique({ where: { id: projection.id } })).toEqual(projection)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orders[1].id } })).status).toBe('SUBMITTED')
  } finally { await peer.$disconnect() }
})


it('rejects unassigned points and rechecks a revoked grant before submitting a draft', async () => {
  const actor = await prisma.user.create({ data: { storeId, email: 'points-checkout@staff.test', name: 'Moderator', role: 'STAFF', passwordHash: '!disabled' } })
  await setBuyerDeliveryPoints(user.id, [], actor)
  try {
    await setCartItem(user, variantId, 1)
    await expect(checkout(user, { deliveryLocationId: locationDeliveryId })).rejects.toMatchObject({ code: 'INVALID_DELIVERY' })
    expect((await getCartView(user)).lines).toHaveLength(1)
    await setBuyerDeliveryPoints(user.id, [locationDeliveryId], actor)
    const order = await checkout(user, { deliveryLocationId: locationDeliveryId })
    await setBuyerDeliveryPoints(user.id, [], actor)
    expect(await listBuyerLocations(user)).toEqual([])
    await expect(submitOrder(user, order.id, prisma)).rejects.toMatchObject({ code: 'INVALID_DELIVERY' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('DRAFT')
    expect(await prisma.orderExport.findUnique({ where: { orderId: order.id } })).toBeNull()
    await setBuyerDeliveryPoints(user.id, [locationDeliveryId], actor)
    await submitOrder(user, order.id, prisma)
    await setBuyerDeliveryPoints(user.id, [], actor)
    expect((await submitOrder(user, order.id, prisma)).status).toBe('SUBMITTED')
  } finally {
    await prisma.userDeliveryPointGrant.deleteMany({ where: { userId: user.id } })
    await prisma.user.update({ where: { id: user.id }, data: { deliveryPointsRestricted: false } })
  }
})


it('lets a newly registered counterparty create its first point and submit while keeping it hidden from a peer account', async () => {
  const customer = await prisma.customer.create({ data: { storeId, displayName: 'New IP', legalName: 'New IP', inn: '123456789012' } })
  const fresh = await prisma.user.create({ data: { storeId, customerId: customer.id, email: 'new-counterparty@points.test', name: 'New buyer', passwordHash: '!disabled', deliveryPointsRestricted: true } })
  const peer = await prisma.user.create({ data: { storeId, customerId: customer.id, email: 'peer-counterparty@points.test', name: 'Peer', passwordHash: '!disabled', deliveryPointsRestricted: true } })
  expect(await listBuyerLocations(fresh)).toEqual([])
  const point = await createBuyerLocation(fresh, { name: 'First shop', city: 'City', address: 'First street' })
  await setCartChannel(fresh, channelId)
  await setCartItem(fresh, variantId, 1)
  const order = await checkout(fresh, { deliveryLocationId: point.id })
  expect((await submitOrder(fresh, order.id, prisma)).status).toBe('SUBMITTED')
  expect(await listBuyerLocations(peer)).toEqual([])
  await setCartChannel(peer, channelId)
  await setCartItem(peer, variantId, 1)
  await expect(checkout(peer, { deliveryLocationId: point.id })).rejects.toMatchObject({ code: 'INVALID_DELIVERY' })
  await prisma.user.update({ where: { id: fresh.id }, data: { status: 'SUSPENDED' } })
  await expect(createBuyerLocation(fresh, { name: 'Denied', city: 'City', address: 'Street' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
})
