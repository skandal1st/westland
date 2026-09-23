import { buyerLocationsWhere, lockDeliveryAccess } from '@/lib/account/location-access'
import { money, lineAmount, sumMoney, oneCurrency } from '@/lib/money'
import { randomUUID } from 'node:crypto'
import { Prisma, type Order, type OrderItem } from '@prisma/client'
import type { SessionUser } from '@/lib/authz'
import { priceVariantsInContext, resolveBuyerPriceGroupId, resolvePriceBookId } from '@/lib/pricing'
import { loadStoreProfile } from '@/lib/store-profile'
import { OrderError, type DraftQuote } from './errors'

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000

export async function assertDraftFresh(tx: Prisma.TransactionClient, createdAt: Date) {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  if (clock.now.getTime() >= createdAt.getTime() + DRAFT_TTL_MS) throw new OrderError('DRAFT_EXPIRED')
  return clock.now
}

/** The caller holds Order FOR UPDATE. No buyer-supplied monetary values are accepted. */
export async function priceDraft(tx: Prisma.TransactionClient, user: SessionUser, order: Order & { items: OrderItem[] }) {
  const now = await assertDraftFresh(tx, order.createdAt)
  await tx.$queryRaw`SELECT id FROM "FulfillmentChannel" WHERE id = ${order.fulfillmentChannelId} FOR SHARE`
  const channel = await tx.fulfillmentChannel.findFirst({ where: { id: order.fulfillmentChannelId, storeId: user.storeId, isActive: true } })
  if (!channel) throw new OrderError('CHANNEL_UNAVAILABLE')
  if (channel.inventoryLocationId !== order.inventoryLocationId || channel.paymentMethod !== order.paymentMethod) throw new OrderError('CHANNEL_CHANGED')
  await lockDeliveryAccess(user, tx)
  if (!await tx.customerLocation.findFirst({ where: { AND: [await buyerLocationsWhere(user, tx), { id: order.deliveryLocationId, customerId: order.customerId }] } })) throw new OrderError('INVALID_DELIVERY')
  if (!order.items.length || order.items.some(item => !item.variantId || !item.productId)) throw new OrderError('ITEM_UNAVAILABLE')
  const ids = order.items.map(item => item.variantId!)
  await tx.$queryRaw(Prisma.sql`SELECT v.id FROM "ProductVariant" v JOIN "Product" p ON p.id = v."productId"
    WHERE v.id IN (${Prisma.join(ids)}) ORDER BY p.id, v.id FOR SHARE OF p, v`)
  const variants = await tx.productVariant.findMany({ where: { id: { in: ids }, storeId: user.storeId, status: 'ACTIVE', product: { storeId: user.storeId, status: 'ACTIVE' } } })
  if (order.items.some(item => !variants.some(v => v.id === item.variantId && v.productId === item.productId))) throw new OrderError('ITEM_UNAVAILABLE')
  const groupId = await resolveBuyerPriceGroupId(user, tx)
  const prices = await priceVariantsInContext({ storeId: user.storeId, variantIds: ids, groupId, channelId: channel.id, date: now, promotions: loadStoreProfile().modules.promotions }, tx)
  const currencies: string[] = []
  const lines = order.items.map(item => {
    const price = prices.get(item.variantId!)
    if (item.giftPromotionId) return { id: item.id, name: item.productName, quantity: item.quantity.toString(), previousUnitPrice: item.unitPrice.toFixed(2), unitPrice: '0.00', lineTotal: '0.00' }
    if (!price) throw new OrderError('NO_PRICE')
    currencies.push(price.currency)
    const unitPrice = money(price.amountExact)
    const lineTotal = lineAmount(unitPrice, item.quantity)
    return { id: item.id, name: item.productName, quantity: item.quantity.toString(), previousUnitPrice: item.unitPrice.toFixed(2), unitPrice, lineTotal }
  })
  const currency = oneCurrency(currencies)
  const total = sumMoney(lines.map(line => line.lineTotal))
  const quote: DraftQuote = { token: randomUUID(), currency: currency!, previousCurrency: order.currency, total, previousTotal: order.total.toFixed(2), lines }
  const changed = currency !== order.currency || total !== order.total.toFixed(2) || lines.some(line => {
    const old = order.items.find(item => item.id === line.id)!
    return !old.unitPrice.equals(line.unitPrice) || !old.lineTotal.equals(line.lineTotal)
  })
  const bookId = await resolvePriceBookId({ storeId: user.storeId, groupId, channelId: channel.id }, tx)
  return { quote, changed, prices, groupId, bookId }
}

/** Includes line identity/quantity/amounts and currencies, not the random challenge token. */
export function quoteTerms(quote: DraftQuote) {
  return JSON.stringify([quote.currency, quote.previousCurrency, quote.total, quote.previousTotal,
    quote.lines.map(line => [line.id, line.name, line.quantity, line.previousUnitPrice, line.unitPrice, line.lineTotal])])
}
