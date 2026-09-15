import { prisma } from '@/lib/db'
import { priceVariantsInContext, resolveBuyerPriceGroupId } from '@/lib/pricing'
import { availabilityForVariants } from '@/lib/pricing/availability'
import { loadStoreProfile } from '@/lib/store-profile'
import type { SessionUser } from '@/lib/authz'

export class CartError extends Error {
  constructor(public code: 'INVALID_CHANNEL' | 'INVALID_VARIANT') {
    super(code)
    this.name = 'CartError'
  }
}

export async function getOrCreateCart(user: Pick<SessionUser, 'id' | 'storeId'>) {
  const existing = await prisma.cart.findUnique({ where: { userId: user.id } })
  if (existing) return existing
  return prisma.cart.create({ data: { storeId: user.storeId, userId: user.id } })
}

export async function setCartChannel(user: SessionUser, channelId: string) {
  const channel = await prisma.fulfillmentChannel.findFirst({ where: { id: channelId, storeId: user.storeId, isActive: true }, select: { id: true } })
  if (!channel) throw new CartError('INVALID_CHANNEL')
  const cart = await getOrCreateCart(user)
  await prisma.cart.update({ where: { id: cart.id }, data: { fulfillmentChannelId: channelId } })
}

/** Set an absolute quantity for a variant (0 removes it). */
export async function setCartItem(user: SessionUser, variantId: string, quantity: number) {
  const cart = await getOrCreateCart(user)
  if (quantity <= 0) {
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id, variantId } })
    return
  }
  const variant = await prisma.productVariant.findFirst({ where: { id: variantId, storeId: user.storeId }, select: { id: true } })
  if (!variant) throw new CartError('INVALID_VARIANT')
  await prisma.cartItem.upsert({
    where: { cartId_variantId: { cartId: cart.id, variantId } },
    update: { quantity },
    create: { cartId: cart.id, variantId, quantity },
  })
}

export async function clearCart(userId: string) {
  const cart = await prisma.cart.findUnique({ where: { userId } })
  if (cart) await prisma.cartItem.deleteMany({ where: { cartId: cart.id } })
}

export type CartLine = {
  variantId: string
  sku: string
  displayName: string
  packaging: string
  quantity: number
  unitPrice: number | null
  lineTotal: number | null
  available: number | null
}

export type CartView = {
  channelId: string | null
  currency: string
  lines: CartLine[]
  total: number
}

/** Live cart view — prices/availability resolved for the cart's channel + buyer group. */
export async function getCartView(user: SessionUser): Promise<CartView> {
  const cart = await prisma.cart.findUnique({
    where: { userId: user.id },
    include: {
      items: {
        orderBy: { createdAt: 'asc' },
        include: { variant: { select: { id: true, sku: true, packaging: true, product: { select: { content: { select: { displayName: true } }, canonicalName: true } } } } },
      },
    },
  })
  if (!cart || cart.items.length === 0) return { channelId: cart?.fulfillmentChannelId ?? null, currency: 'RUB', lines: [], total: 0 }

  const groupId = await resolveBuyerPriceGroupId(user)
  const variantIds = cart.items.map((item) => item.variantId)
  const prices = await priceVariantsInContext({ storeId: user.storeId, variantIds, groupId, channelId: cart.fulfillmentChannelId, promotions: loadStoreProfile().modules.promotions })
  const availability = cart.fulfillmentChannelId ? await availabilityForVariants({ variantIds, channelId: cart.fulfillmentChannelId }) : new Map()

  let total = 0
  let currency = 'RUB'
  const lines: CartLine[] = cart.items.map((item) => {
    const quantity = Number(item.quantity)
    const price = prices.get(item.variantId) ?? null
    const lineTotal = price ? price.amount * quantity : null
    if (price) { total += lineTotal ?? 0; currency = price.currency }
    const avail = availability.get(item.variantId)
    return {
      variantId: item.variantId,
      sku: item.variant.sku,
      displayName: item.variant.product.content?.displayName ?? item.variant.product.canonicalName,
      packaging: item.variant.packaging,
      quantity,
      unitPrice: price?.amount ?? null,
      lineTotal,
      available: avail ? avail.available : null,
    }
  })
  return { channelId: cart.fulfillmentChannelId, currency, lines, total }
}
