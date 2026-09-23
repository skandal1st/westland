import { categoryAncestry } from '@/lib/catalog/tree'
import { z } from 'zod'
import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'
import { effectiveCapabilities } from '@/lib/capabilities'
import { resolveBuyerPriceGroupId } from '@/lib/pricing'
import type { SessionUser } from '@/lib/authz'
const facets = z.object({ productId: z.string().min(1).optional(), brandId: z.string().min(1).optional(), categoryId: z.string().min(1).optional(), packaging: z.string().trim().min(1).max(200).optional() }).strict().refine(v => Object.values(v).some(Boolean), 'Выберите товар, бренд или категорию')
export const giftRuleSchema = z.object({ condition: facets, reward: facets, minQty: z.number().int().min(1).max(100000), rewardQty: z.number().int().min(1).max(100000), maxRewardQty: z.number().int().min(1).max(100000).nullable().default(null), channelIds: z.array(z.string().min(1)).max(100).default([]), priceGroupIds: z.array(z.string().min(1)).max(100).default([]) }).strict()
export type GiftRule = z.infer<typeof giftRuleSchema>
type Facets = GiftRule['condition']
type Client = PrismaClient | Prisma.TransactionClient
export type GiftCandidate = { variantId: string; productId: string; name: string; sku: string; sourceSku: string | null; packaging: string; available: number }
export type GiftOffer = { id: string; name: string; quantity: number; remaining: number; requiresChoice: boolean; selection: string | null; gift: GiftCandidate | null; unavailable: boolean }
export function matchesGiftCondition(f: Facets, item: { productId: string; brandId: string | null; categoryId: string | null; categoryAncestorIds?: string[]; packaging: string }) {
  return (!f.productId || f.productId === item.productId) && (!f.brandId || f.brandId === item.brandId) && (!f.categoryId || (f.categoryId === item.categoryId || item.categoryAncestorIds?.includes(f.categoryId))) && (!f.packaging || f.packaging === item.packaging)
}
export function earnedGifts(rule: GiftRule, quantity: Prisma.Decimal) {
  return Math.min(quantity.div(rule.minQty).floor().mul(rule.rewardQty).toNumber(), rule.maxRewardQty ?? 100000)
}
export async function validateGiftRule(storeId: string, rule: GiftRule, client: Client = prisma) {
  for (const f of [rule.condition, rule.reward]) {
    if (f.productId && !await client.product.findFirst({ where: { id: f.productId, storeId, status: 'ACTIVE' } })) return false
    if (f.brandId && !await client.brand.findFirst({ where: { id: f.brandId, storeId } })) return false
    if (f.categoryId && !await client.category.findFirst({ where: { id: f.categoryId, storeId } })) return false
  }
  if (await client.fulfillmentChannel.count({ where: { storeId, id: { in: rule.channelIds } } }) !== new Set(rule.channelIds).size) return false
  if (await client.priceGroup.count({ where: { storeId, id: { in: rule.priceGroupIds } } }) !== new Set(rule.priceGroupIds).size) return false
  return true
}
function rewardWhere(storeId: string, channelId: string, f: Facets, qty: number, search = '', categoryIds?: string[]): Prisma.ProductVariantWhereInput {
  return { storeId, isDefault: true, status: 'ACTIVE', ...(f.packaging ? { packaging: f.packaging } : {}),
    product: { storeId, status: 'ACTIVE', ...(f.productId ? { id: f.productId } : {}), ...(f.brandId ? { brandId: f.brandId } : {}), ...(f.categoryId ? { categoryId: { in: categoryIds ?? [f.categoryId] } } : {}),
      ...(search ? { OR: [{ canonicalName: { contains: search, mode: 'insensitive' } }, { content: { displayName: { contains: search, mode: 'insensitive' } } }, { variants: { some: { sourceSku: { contains: search, mode: 'insensitive' } } } }] } : {}) },
    availability: { some: { fulfillmentChannelId: channelId, availableQuantity: { gte: qty } } },
  }
}
async function candidateList(storeId: string, channelId: string, f: Facets, qty: number, client: Client, options: { variantId?: string; search?: string; take?: number } = {}): Promise<GiftCandidate[]> {
  const categories=f.categoryId?await client.category.findMany({where:{storeId},select:{id:true,parentId:true}}):[]
  const ancestry=categoryAncestry(categories),categoryIds=f.categoryId?categories.filter(c=>ancestry(c.id).includes(f.categoryId!)).map(c=>c.id):undefined
  const rows = await client.productVariant.findMany({ where: { ...rewardWhere(storeId, channelId, f, qty, options.search, categoryIds), ...(options.variantId ? { id: options.variantId } : {}) },
    take: options.take ?? 50, orderBy: [{ product: { canonicalName: 'asc' } }, { id: 'asc' }],
    select: { id: true, productId: true, sku: true, sourceSku: true, packaging: true, product: { select: { canonicalName: true, content: { select: { displayName: true } } } }, availability: { where: { fulfillmentChannelId: channelId }, select: { availableQuantity: true } } } })
  return rows.map(v => ({ variantId: v.id, productId: v.productId, sku: v.sku, sourceSku: v.sourceSku, packaging: v.packaging, name: v.product.content?.displayName ?? v.product.canonicalName, available: Number(v.availability[0]?.availableQuantity ?? 0) }))
}
/** Gifts never enter the paid cart, so they cannot trigger another reward. Recomputed at checkout. */
export async function getGiftOffers(user: SessionUser, cart: { fulfillmentChannelId: string | null; giftSelections?: Prisma.JsonValue; items: Array<{ variantId: string; quantity: Prisma.Decimal }> }, client: Client = prisma): Promise<GiftOffer[]> {
  if (!cart.fulfillmentChannelId || !cart.items.length || !effectiveCapabilities().includes('promotions')) return []
  const now = new Date(), channelId = cart.fulfillmentChannelId
  const [promotions, variants, groupId] = await Promise.all([
    client.giftPromotion.findMany({ where: { storeId: user.storeId, isActive: true, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    client.productVariant.findMany({ where: { id: { in: cart.items.map(i => i.variantId) }, storeId: user.storeId, status: 'ACTIVE', product: { status: 'ACTIVE' } }, select: { id: true, productId: true, packaging: true, product: { select: { brandId: true, categoryId: true } } } }),
    resolveBuyerPriceGroupId(user, client),
  ])
  const ancestry=categoryAncestry(promotions.length?await client.category.findMany({where:{storeId:user.storeId},select:{id:true,parentId:true}}):[])
  const byId = new Map(variants.map(v => [v.id, v])), consumed = new Map(cart.items.map(i => [i.variantId, Number(i.quantity)]))
  const selections = (cart.giftSelections ?? {}) as Record<string, unknown>
  const offers: GiftOffer[] = []
  for (const promotion of promotions) {
    const parsed = giftRuleSchema.safeParse(promotion.rule)
    if (!parsed.success) continue
    const rule = parsed.data
    if (rule.channelIds.length && !rule.channelIds.includes(channelId) || rule.priceGroupIds.length && (!groupId || !rule.priceGroupIds.includes(groupId))) continue
    let matched = new Prisma.Decimal(0)
    for (const item of cart.items) { const v = byId.get(item.variantId); if (v && matchesGiftCondition(rule.condition, { ...v, ...v.product, categoryAncestorIds:ancestry(v.product.categoryId) })) matched = matched.add(item.quantity) }
    if (matched.lte(0)) continue
    const quantity = earnedGifts(rule, matched)
    const remaining = quantity >= (rule.maxRewardQty ?? 100000) ? 0 : new Prisma.Decimal(rule.minQty).sub(matched.mod(rule.minQty)).toNumber()
    const selected = typeof selections[promotion.id] === 'string' ? selections[promotion.id] as string : null
    const requiresChoice = !rule.reward.productId
    let gift: GiftCandidate | null = null
    let unavailable = false
    if (quantity && selected !== 'SKIP') {
      if (!requiresChoice || selected) {
        const candidates = await candidateList(user.storeId, channelId, rule.reward, quantity, client, { variantId: requiresChoice ? selected! : undefined, take: 1 })
        gift = candidates[0] ?? null
        if (gift && gift.available - (consumed.get(gift.variantId) ?? 0) < quantity) gift = null
        unavailable = !gift
        if (gift) consumed.set(gift.variantId, (consumed.get(gift.variantId) ?? 0) + quantity)
      }
    }
    offers.push({ id: promotion.id, name: promotion.name, quantity, remaining, requiresChoice, selection: selected, gift, unavailable })
  }
  return offers
}
export async function giftOptions(user: SessionUser, cart: Parameters<typeof getGiftOffers>[1], promotionId: string, search: string) {
  const offer = (await getGiftOffers(user, cart)).find(o => o.id === promotionId)
  if (!offer?.quantity || !cart.fulfillmentChannelId) return []
  const promotion = await prisma.giftPromotion.findFirst({ where: { id: promotionId, storeId: user.storeId, isActive: true } })
  const parsed = giftRuleSchema.safeParse(promotion?.rule)
  if (!parsed.success) return []
  const candidates = await candidateList(user.storeId, cart.fulfillmentChannelId, parsed.data.reward, offer.quantity, prisma, { search })
  return candidates.filter(c => c.available - Number(cart.items.find(i => i.variantId === c.variantId)?.quantity ?? 0) >= offer.quantity)
}
