import { getGiftOffers, giftOptions, giftRuleSchema } from '@/lib/promotions/gifts'
import { effectiveCapabilities } from '@/lib/capabilities'
import { listBuyerLocations, createBuyerLocation } from '@/lib/account/locations'
import { submitOrder, cancelOrder } from '@/lib/orders/orders'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
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
  const store = await prisma.store.findUnique({ where: { slug: 'test-gift-checkout' } })
  if (store) {
    await prisma.order.deleteMany({ where: { storeId: store.id } })
    await prisma.store.delete({ where: { id: store.id } })
  }
}

beforeAll(async () => {
  await cleanup()
  const store = await prisma.store.create({ data: { slug: 'test-gift-checkout', name: 'Test Checkout' } })
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
  await prisma.giftPromotion.deleteMany({ where: { storeId } })
  await prisma.cart.update({ where: { userId: user.id }, data: { giftSelections: {} } })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})


async function setupGift(group = false) {
  expect(effectiveCapabilities()).toContain('promotions')
  let gift = await prisma.productVariant.findFirst({ where: { storeId, sku: 'GIFT' } })
  if (!gift) {
    const category = await prisma.category.create({ data: { storeId, name: 'Gifts', slug: 'gifts' } })
    const product = await prisma.product.create({ data: { storeId, canonicalName: 'Подарок', status: 'ACTIVE', categoryId: category.id } })
    gift = await prisma.productVariant.create({ data: { storeId, productId: product.id, sku: 'GIFT' } })
  }
  const channel = await prisma.fulfillmentChannel.findUniqueOrThrow({ where: { id: channelId } })
  await prisma.stock.upsert({ where: { variantId_locationId: { variantId: gift.id, locationId: channel.inventoryLocationId } }, create: { variantId: gift.id, locationId: channel.inventoryLocationId, available: 5 }, update: { available: 5 } })
  await projectChannelAvailability(channelId, prisma)
  const paid = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })
  const giftProduct = await prisma.product.findUniqueOrThrow({ where: { id: gift.productId } })
  const rule = giftRuleSchema.parse({ condition: { productId: paid.productId }, reward: group ? { categoryId: giftProduct.categoryId } : { productId: gift.productId }, minQty: 2, rewardQty: 1, maxRewardQty: 2 })
  const promo = await prisma.giftPromotion.create({ data: { storeId, name: '2 + 1', isActive: true, rule } })
  return { gift, promo, rule }
}
const liveCart = () => prisma.cart.findUniqueOrThrow({ where: { userId: user.id }, include: { items: true } })
it('shows progress, awards repeated thresholds with a cap, removes gifts when the condition stops matching', async () => {
  await setupGift(); await setCartItem(user, variantId, 1)
  expect((await getCartView(user)).gifts?.[0]).toMatchObject({ quantity: 0, remaining: 1 })
  await setCartItem(user, variantId, 6)
  expect((await getCartView(user)).gifts?.[0]).toMatchObject({ quantity: 2, remaining: 0 })
  await setCartItem(user, variantId, 0)
  expect((await getGiftOffers(user, await liveCart()))).toHaveLength(0)
})
it('snapshots free gifts, preserves zero at submission/export and replays checkout without duplicating rewards', async () => {
  const { gift, promo } = await setupGift(); await setCartItem(user, variantId, 2)
  const input = { deliveryLocationId: locationDeliveryId, idempotencyKey: 'gift-idempotent' }
  const order = await checkout(user, input)
  expect(order.total.toFixed(2)).toBe('1180.00')
  const lines = await prisma.orderItem.findMany({ where: { orderId: order.id } })
  expect(lines).toHaveLength(2)
  expect(lines.find(l => l.giftPromotionId)?.unitPrice.toFixed(2)).toBe('0.00')
  expect(lines.find(l => l.giftPromotionId)?.variantId).toBe(gift.id)
  await prisma.giftPromotion.delete({ where: { id: promo.id } })
  expect((await checkout(user, input)).id).toBe(order.id)
  await submitOrder(user, order.id)
  const sent = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
  expect(sent.total.toFixed(2)).toBe('1180.00')
  expect((sent.commercialSnapshot as any).lines.find((l: any) => l.promotionIds.includes(promo.id))).toMatchObject({ unitPrice: '0.00', lineTotal: '0.00' })
})
it('requires an eligible group selection, rejects a forged paid item as gift, permits opting out', async () => {
  const { gift, promo } = await setupGift(true); await setCartItem(user, variantId, 2)
  expect((await giftOptions(user, await liveCart(), promo.id, 'Подарок'))[0].variantId).toBe(gift.id)
  await expect(checkout(user, { deliveryLocationId: locationDeliveryId })).rejects.toMatchObject({ code: 'GIFT_SELECTION_REQUIRED' })
  await prisma.cart.update({ where: { userId: user.id }, data: { giftSelections: { [promo.id]: variantId } } })
  await expect(checkout(user, { deliveryLocationId: locationDeliveryId })).rejects.toMatchObject({ code: 'GIFT_SELECTION_REQUIRED' })
  await prisma.cart.update({ where: { userId: user.id }, data: { giftSelections: { [promo.id]: gift.id } } })
  expect((await getCartView(user)).gifts?.[0].gift?.variantId).toBe(gift.id)
  await prisma.cart.update({ where: { userId: user.id }, data: { giftSelections: { [promo.id]: 'SKIP' } } })
  const order = await checkout(user, { deliveryLocationId: locationDeliveryId })
  expect(await prisma.orderItem.count({ where: { orderId: order.id } })).toBe(1)
})
it('honors dates, channels, customer groups and stock, without cascading earned gifts into conditions', async () => {
  const { gift, promo, rule } = await setupGift(); await setCartItem(user, variantId, 2)
  await prisma.giftPromotion.update({ where: { id: promo.id }, data: { endsAt: new Date(0) } })
  expect(await getGiftOffers(user, await liveCart())).toHaveLength(0)
  await prisma.giftPromotion.update({ where: { id: promo.id }, data: { endsAt: null, rule: { ...rule, channelIds: ['another-channel'] } } })
  expect(await getGiftOffers(user, await liveCart())).toHaveLength(0)
  await prisma.giftPromotion.update({ where: { id: promo.id }, data: { rule: { ...rule, priceGroupIds: ['another-group'] } } })
  expect(await getGiftOffers(user, await liveCart())).toHaveLength(0)
  await prisma.giftPromotion.update({ where: { id: promo.id }, data: { rule } })
  await prisma.availabilityProjection.updateMany({ where: { variantId: gift.id }, data: { availableQuantity: 0 } })
  expect((await getGiftOffers(user, await liveCart()))[0]).toMatchObject({ unavailable: true, gift: null })
  await prisma.giftPromotion.create({ data: { storeId, name: 'No chain', isActive: true, rule: { ...rule, condition: { productId: gift.productId } } } })
  expect(await getGiftOffers(user, await liveCart())).toHaveLength(1)
})
