import { prisma } from '@/lib/db'
import { resolveBuyerPriceGroupId, resolveVariantPrice } from '@/lib/pricing'
import { availabilityForVariants } from '@/lib/pricing/availability'
import { loadStoreProfile } from '@/lib/store-profile'
import { assertLicenseActive } from '@/lib/license'
import type { SessionUser } from '@/lib/authz'

export class CheckoutError extends Error {
  constructor(public code: 'EMPTY_CART' | 'NO_CHANNEL' | 'NO_CUSTOMER' | 'INVALID_DELIVERY' | 'NO_PRICE' | 'INSUFFICIENT_STOCK') {
    super(code)
    this.name = 'CheckoutError'
  }
}

/**
 * Turn the cart into a DRAFT order. Prices and availability are re-resolved
 * server-side and snapshotted onto the order — the client can never dictate
 * price, and stock is validated at this moment. Idempotent via idempotencyKey.
 */
export async function checkout(
  user: SessionUser,
  input: { deliveryLocationId: string; comment?: string; idempotencyKey?: string },
) {
  // License is verified before any order is written; a blocked license never
  // creates a partial order (controlled degradation, no data corruption).
  assertLicenseActive()
  if (!user.customerId) throw new CheckoutError('NO_CUSTOMER')

  if (input.idempotencyKey) {
    const existing = await prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
    if (existing) return existing
  }

  const cart = await prisma.cart.findUnique({ where: { userId: user.id }, include: { items: true } })
  if (!cart || cart.items.length === 0) throw new CheckoutError('EMPTY_CART')
  if (!cart.fulfillmentChannelId) throw new CheckoutError('NO_CHANNEL')

  const channel = await prisma.fulfillmentChannel.findFirst({ where: { id: cart.fulfillmentChannelId, storeId: user.storeId } })
  if (!channel) throw new CheckoutError('NO_CHANNEL')

  const delivery = await prisma.customerLocation.findFirst({ where: { id: input.deliveryLocationId, customerId: user.customerId } })
  if (!delivery) throw new CheckoutError('INVALID_DELIVERY')

  const groupId = await resolveBuyerPriceGroupId(user)
  const promotions = loadStoreProfile().modules.promotions
  const variantIds = cart.items.map((item) => item.variantId)
  const availability = await availabilityForVariants({ variantIds, channelId: channel.id })

  // Re-validate + snapshot each line server-side.
  const variants = await prisma.productVariant.findMany({
    where: { id: { in: variantIds } },
    select: { id: true, sku: true, packaging: true, productId: true, product: { select: { content: { select: { displayName: true } }, canonicalName: true } } },
  })
  const variantById = new Map(variants.map((v) => [v.id, v]))

  const lines = [] as Array<{ variantId: string; productId: string; sku: string; productName: string; packaging: string; quantity: number; unitPrice: number; lineTotal: number }>
  let total = 0
  let currency = 'RUB'
  for (const item of cart.items) {
    const variant = variantById.get(item.variantId)
    if (!variant) throw new CheckoutError('NO_PRICE')
    const quantity = Number(item.quantity)
    const price = await resolveVariantPrice({ storeId: user.storeId, variantId: item.variantId, groupId, channelId: channel.id, promotions })
    if (!price) throw new CheckoutError('NO_PRICE')
    const avail = availability.get(item.variantId)
    if (!avail || avail.available < quantity) throw new CheckoutError('INSUFFICIENT_STOCK')
    const lineTotal = price.amount * quantity
    total += lineTotal
    currency = price.currency
    lines.push({
      variantId: variant.id, productId: variant.productId, sku: variant.sku,
      productName: variant.product.content?.displayName ?? variant.product.canonicalName,
      packaging: variant.packaging, quantity, unitPrice: price.amount, lineTotal,
    })
  }

  return prisma.$transaction(async (tx) => {
    const settings = await tx.appSettings.findUnique({ where: { storeId: user.storeId }, select: { invoicePrefix: true } })
    const prefix = settings?.invoicePrefix ?? 'WS'
    const seq = (await tx.order.count({ where: { storeId: user.storeId } })) + 1
    const number = `${prefix}-${String(seq).padStart(5, '0')}`

    const order = await tx.order.create({
      data: {
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
            productId: line.productId, variantId: line.variantId, sku: line.sku,
            productName: line.productName, packaging: line.packaging,
            quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: line.lineTotal,
          })),
        },
      },
    })

    await tx.cartItem.deleteMany({ where: { cartId: cart.id } })
    return order
  })
}
