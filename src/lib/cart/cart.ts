import { getGiftOffers, type GiftOffer } from '@/lib/promotions/gifts'
import { lineAmount, sumMoney, oneCurrency, MoneyError } from '@/lib/money'
import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'
import { priceVariantsInContext, resolveBuyerPriceGroupId } from '@/lib/pricing'
import { availabilityForVariants } from '@/lib/pricing/availability'
import { loadStoreProfile } from '@/lib/store-profile'
import type { SessionUser } from '@/lib/authz'

export class CartError extends Error {
  constructor(public code: 'INVALID_CHANNEL' | 'INVALID_VARIANT' | 'INVALID_AMOUNT' | 'MIXED_CURRENCY') {
    super(code)
    this.name = 'CartError'
  }
}

export async function getOrCreateCart(user: Pick<SessionUser, 'id' | 'storeId'>, client: PrismaClient = prisma) {
  // A nonempty no-op update keeps this a native PostgreSQL upsert.
  // Prisma emulates an empty-update upsert with a racy read/create pair.
  return client.cart.upsert({ where: { userId: user.id }, create: { storeId: user.storeId, userId: user.id }, update: { userId: user.id } })
}

// Always lock/update the parent before touching its lines, including checkout.
export async function setCartChannel(user: SessionUser, channelId: string, client: PrismaClient = prisma) {
  const cart = await getOrCreateCart(user, client)
  await client.$transaction(async tx => {
    await tx.cart.update({ where: { id: cart.id, storeId: user.storeId }, data: { version: { increment: 1 } } })
    const channel = await tx.fulfillmentChannel.findFirst({ where: { id: channelId, storeId: user.storeId, isActive: true }, select: { id: true } })
    if (!channel) throw new CartError('INVALID_CHANNEL')
    await tx.cart.update({ where: { id: cart.id }, data: { fulfillmentChannelId: channelId } })
  })
}

/** Set an absolute quantity for a variant (0 removes it). */
export async function setCartItem(user: SessionUser, variantId: string, quantity: number, client: PrismaClient = prisma) {
  const cart = await getOrCreateCart(user, client)
  await client.$transaction(async tx => {
    await tx.cart.update({ where: { id: cart.id, storeId: user.storeId }, data: { version: { increment: 1 } } })
    if (quantity <= 0) {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id, variantId } })
      return
    }
    const variant = await tx.productVariant.findFirst({ where: { id: variantId, storeId: user.storeId }, select: { id: true } })
    if (!variant) throw new CartError('INVALID_VARIANT')
    await tx.cartItem.upsert({ where: { cartId_variantId: { cartId: cart.id, variantId } }, update: { quantity }, create: { cartId: cart.id, variantId, quantity } })
  })
}

export async function clearCart(userId: string, client: PrismaClient = prisma) {
  await client.$transaction(async tx => {
    const cart = await tx.cart.findUnique({ where: { userId } })
    if (!cart) return
    await tx.cart.update({ where: { id: cart.id }, data: { version: { increment: 1 } } })
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } })
  })
}
export type CartLine = {
  variantId: string
  sku: string
  sourceSku?: string | null
  displayName: string
  packaging: string
  quantity: number
  unitPrice: string | null
  lineTotal: string | null
  available: number | null
}

export type CartView = {
  gifts?: GiftOffer[]
  cartId: string | null
  version: number | null
  channelId: string | null
  currency: string
  lines: CartLine[]
  total: string
}

/** Live cart view — prices/availability resolved for the cart's channel + buyer group. */
async function buildCartView(user: SessionUser): Promise<CartView> {
  const cart = await prisma.$transaction(tx => tx.cart.findUnique({
    where: { userId: user.id },
    include: {
      items: {
        orderBy: { createdAt: 'asc' },
        include: { variant: { select: { id: true, sku: true, sourceSku: true, packaging: true, product: { select: { content: { select: { displayName: true } }, canonicalName: true } } } } },
      },
    },
  }), { isolationLevel: 'RepeatableRead' })
  if (!cart || cart.items.length === 0) return { cartId: cart?.id ?? null, version: cart?.version ?? null, channelId: cart?.fulfillmentChannelId ?? null, currency: 'RUB', lines: [], total: '0.00' }

  const groupId = await resolveBuyerPriceGroupId(user)
  const variantIds = cart.items.map((item) => item.variantId)
  const prices = await priceVariantsInContext({ storeId: user.storeId, variantIds, groupId, channelId: cart.fulfillmentChannelId, promotions: loadStoreProfile().modules.promotions })
  const availability = cart.fulfillmentChannelId ? await availabilityForVariants({ variantIds, channelId: cart.fulfillmentChannelId }) : new Map()

  const currencies: string[] = []
  const lines: CartLine[] = cart.items.map((item) => {
    const quantity = Number(item.quantity)
    const price = prices.get(item.variantId) ?? null
    const lineTotal = price ? lineAmount(price.amountExact, item.quantity) : null
    if (price) currencies.push(price.currency)
    const avail = availability.get(item.variantId)
    return {
      variantId: item.variantId,
      sku: item.variant.sku,
      sourceSku: item.variant.sourceSku,
      displayName: item.variant.product.content?.displayName ?? item.variant.product.canonicalName,
      packaging: item.variant.packaging,
      quantity,
      unitPrice: price?.amountExact ?? null,
      lineTotal,
      available: avail ? avail.available : null,
    }
  })
  const total = sumMoney(lines.flatMap(line => line.lineTotal === null ? [] : [line.lineTotal]))
  const currency = currencies.length ? oneCurrency(currencies) : 'RUB'
  const gifts = await getGiftOffers(user, cart)
  return { cartId: cart.id, version: cart.version, channelId: cart.fulfillmentChannelId, currency, lines, total, gifts }
}

export async function getCartView(user: SessionUser): Promise<CartView> {
  try { return await buildCartView(user) } catch (error) {
    if (error instanceof MoneyError) throw new CartError(error.code)
    throw error
  }
}
