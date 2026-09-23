import { getGiftOffers } from '@/lib/promotions/gifts'
import { assertCapability } from '@/lib/capabilities'
import { buyerLocationsWhere, lockDeliveryAccess } from '@/lib/account/location-access'
import { lineAmount, sumMoney, oneCurrency, MoneyError } from '@/lib/money'
import { createHash } from 'node:crypto'
import { Prisma, type Order, type PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'
import { resolveBuyerPriceGroupId, priceVariantsInContext } from '@/lib/pricing'
import { loadStoreProfile } from '@/lib/store-profile'
import type { SessionUser } from '@/lib/authz'

export class CheckoutError extends Error {
  constructor(public code: 'GIFT_SELECTION_REQUIRED' | 'EMPTY_CART' | 'NO_CHANNEL' | 'NO_CUSTOMER' | 'INVALID_DELIVERY' | 'NO_PRICE' | 'CART_CHANGED' | 'IDEMPOTENCY_CONFLICT' | 'ITEM_UNAVAILABLE' | 'MIXED_CURRENCY' | 'INVALID_AMOUNT') {
    super(code)
    this.name = 'CheckoutError'
  }
}

/**
 * Create a DRAFT request, without stock reservation or an availability promise.
 * Prices and eligibility are checked server-side; ERP decides fulfilment later.
 * Cached availability is informational and cannot block a request.
 */
export async function checkout(
  user: SessionUser,
  input: { deliveryLocationId: string; comment?: string; idempotencyKey?: string; cartId?: string; cartVersion?: number },
  client: PrismaClient = prisma,
) {
  assertCapability('commerce-b2b')

  // License is verified before any order is written; a blocked license never
  // creates a partial order (controlled degradation, no data corruption).
  if (!user.customerId) throw new CheckoutError('NO_CUSTOMER')

  const intent = createHash('sha256').update(JSON.stringify([input.deliveryLocationId, input.comment ?? ''])).digest('hex')
  const assertReplay = (order: Order) => {
    if (order.storeId !== user.storeId || order.userId !== user.id || order.customerId !== user.customerId ||
      (order.checkoutIntent ? order.checkoutIntent !== intent : order.deliveryLocationId !== input.deliveryLocationId || order.comment !== (input.comment ?? '')) ||
      (input.cartId !== undefined && order.checkoutCartId !== null && order.checkoutCartId !== input.cartId) ||
      (input.cartVersion !== undefined && order.checkoutCartVersion !== null && order.checkoutCartVersion !== input.cartVersion)) {
      throw new CheckoutError('IDEMPOTENCY_CONFLICT')
    }
    return order
  }
  // Internal callers may omit a version; freeze it before waiting for any lock.
  // HTTP requires the exact cart ID and revision displayed to the buyer.
  const observed = input.cartId !== undefined && input.cartVersion !== undefined
    ? { id: input.cartId, version: input.cartVersion }
    : await client.cart.findUnique({ where: { userId: user.id }, select: { id: true, version: true } })

  return client.$transaction(async tx => {
    if (input.idempotencyKey) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'checkout-key:' + input.idempotencyKey}, 0))`
      const receipt = await tx.checkoutReceipt.findUnique({ where: { key: input.idempotencyKey }, include: { order: true } })
      const existing = receipt?.order ?? await tx.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
      if (existing) return assertReplay(existing)
    }
    if (!observed) throw new CheckoutError('EMPTY_CART')
    await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${observed.id} AND "userId" = ${user.id} AND "storeId" = ${user.storeId} FOR UPDATE`
    const cart = await tx.cart.findFirst({ where: { id: observed.id, userId: user.id, storeId: user.storeId }, include: { items: true } })
    if (!cart) throw new CheckoutError('CART_CHANGED')
    const remember = async (order: Order) => {
      if (input.idempotencyKey) await tx.checkoutReceipt.create({ data: { key: input.idempotencyKey, orderId: order.id } })
      return order
    }
    if (cart.version !== observed.version) {
      const previous = await tx.order.findUnique({ where: { checkoutCartId_checkoutCartVersion: { checkoutCartId: cart.id, checkoutCartVersion: observed.version } } })
      if (previous) return remember(assertReplay(previous))
      throw new CheckoutError('CART_CHANGED')
    }
    if (!cart.items.length) throw new CheckoutError('EMPTY_CART')
    if (!cart.fulfillmentChannelId) throw new CheckoutError('NO_CHANNEL')

    await tx.$queryRaw`SELECT id FROM "FulfillmentChannel" WHERE id = ${cart.fulfillmentChannelId} FOR SHARE`
    const channel = await tx.fulfillmentChannel.findFirst({ where: { id: cart.fulfillmentChannelId, storeId: user.storeId, isActive: true } })
    if (!channel) throw new CheckoutError('NO_CHANNEL')

    await lockDeliveryAccess(user, tx)
    const delivery = await tx.customerLocation.findFirst({ where: { AND: [await buyerLocationsWhere(user, tx), { id: input.deliveryLocationId }] } })
    if (!delivery) throw new CheckoutError('INVALID_DELIVERY')

    const groupId = await resolveBuyerPriceGroupId(user, tx)
    const promotions = loadStoreProfile().modules.promotions
    const variantIds = cart.items.map((item) => item.variantId)

    // Re-validate + snapshot each line server-side.
    await tx.$queryRaw(Prisma.sql`SELECT v.id FROM "ProductVariant" v JOIN "Product" p ON p.id = v."productId"
      WHERE v.id IN (${Prisma.join(variantIds)}) ORDER BY p.id, v.id FOR SHARE OF p, v`)
    const variants = await tx.productVariant.findMany({
      where: { id: { in: variantIds }, storeId: user.storeId, status: 'ACTIVE', product: { storeId: user.storeId, status: 'ACTIVE' } },
      select: { id: true, sku: true, sourceSku: true, packaging: true, productId: true, product: { select: { content: { select: { displayName: true } }, canonicalName: true } } },
    })
    const variantById = new Map(variants.map((v) => [v.id, v]))

    const lines = [] as Array<{ variantId: string; productId: string; sku: string; sourceSku: string | null; productName: string; packaging: string; quantity: string; unitPrice: string; lineTotal: string; giftPromotionId?: string; giftPromotionName?: string }>
    const prices = await priceVariantsInContext({ storeId: user.storeId, variantIds, groupId, channelId: channel.id, promotions }, tx)
    const currencies: string[] = []
    for (const item of cart.items) {
      const variant = variantById.get(item.variantId)
      if (!variant) throw new CheckoutError('ITEM_UNAVAILABLE')
      const quantity = item.quantity.toString()
      const price = prices.get(item.variantId)
      if (!price) throw new CheckoutError('NO_PRICE')
      const lineTotal = lineAmount(price.amountExact, quantity)
      currencies.push(price.currency)
      lines.push({
        variantId: variant.id, productId: variant.productId, sku: variant.sku, sourceSku: variant.sourceSku,
        productName: variant.product.content?.displayName ?? variant.product.canonicalName,
        packaging: variant.packaging, quantity, unitPrice: price.amountExact, lineTotal,
      })
    }

    const gifts = await getGiftOffers(user, cart, tx)
    for (const offer of gifts) {
      if (!offer.quantity || offer.selection === 'SKIP') continue
      if (offer.requiresChoice && !offer.gift) throw new CheckoutError('GIFT_SELECTION_REQUIRED')
      if (!offer.gift) continue
      const gift = offer.gift
      lines.push({ variantId: gift.variantId, productId: gift.productId, sku: gift.sku, sourceSku: gift.sourceSku,
        productName: gift.name + ' · Промотовар: ' + offer.name, packaging: gift.packaging, quantity: String(offer.quantity), unitPrice: '0.00', lineTotal: '0.00', giftPromotionId: offer.id, giftPromotionName: offer.name })
    }
    const total = sumMoney(lines.map(line => line.lineTotal))
    const currency = oneCurrency(currencies)
    const settings = await tx.appSettings.findUnique({ where: { storeId: user.storeId }, select: { invoicePrefix: true } })
    const prefix = settings?.invoicePrefix ?? 'WS'
    // The store lock serializes initialization as well as increments.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'order-number:' + user.storeId}, 0))`
    const counter = await tx.orderNumberCounter.findUnique({ where: { storeId: user.storeId } })
    if (!counter) {
      const [legacy] = await tx.$queryRaw<Array<{ value: bigint }>>`SELECT COALESCE(MAX(substring(number from '-([0-9]+)$')::bigint), 0) AS value FROM "Order" WHERE "storeId" = ${user.storeId}`
      await tx.orderNumberCounter.create({ data: { storeId: user.storeId, value: legacy.value } })
    }
    const { value: seq } = await tx.orderNumberCounter.update({ where: { storeId: user.storeId }, data: { value: { increment: 1 } } })
    const number = `${prefix}-${String(seq).padStart(5, '0')}`

    const order = await tx.order.create({
      data: {
        checkoutCartId: cart.id,
        checkoutCartVersion: cart.version,
        checkoutIntent: intent,
        storeId: user.storeId,
        customerId: user.customerId!,
        userId: user.id,
        deliveryLocationId: delivery.id,
        inventoryLocationId: channel.inventoryLocationId,
        fulfillmentChannelId: channel.id,
        paymentMethod: channel.paymentMethod,
        number,
        status: 'DRAFT',
        idempotencyKey: input.idempotencyKey ?? null,
        total,
        currency,
        comment: input.comment ?? '',
        items: {
          create: lines.map((line) => ({
            productId: line.productId, variantId: line.variantId, sku: line.sku, sourceSku: line.sourceSku,
            productName: line.productName, packaging: line.packaging, giftPromotionId: line.giftPromotionId, giftPromotionName: line.giftPromotionName,
            quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: line.lineTotal,
          })),
        },
      },
    })

    await tx.cartItem.deleteMany({ where: { cartId: cart.id } })
    await tx.cart.update({ where: { id: cart.id }, data: { version: { increment: 1 }, giftSelections: Prisma.DbNull } })
    return remember(order)
  }, { timeout: 30_000, maxWait: 10_000 }).catch(error => {
    if (error instanceof MoneyError) throw new CheckoutError(error.code)
    throw error
  })
}
