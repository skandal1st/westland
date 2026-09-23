import { effectiveCapabilities } from '@/lib/capabilities'
import { decimal, money, type DecimalInput } from '@/lib/money'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'

type Client = PrismaClient | Prisma.TransactionClient

/**
 * Promotion is the M5 pricing extension point (see plan §M5 non-goals / §M9).
 * It never mutates a PriceEntry — it discounts the *resolved contextual price*
 * at read time, so a released invoice snapshot is never retroactively altered.
 *
 * Targeting (`scope`): brand / category / variant ids. Absent or all-empty
 * scope means "applies to every variant". Overlaps resolve by `priority`
 * (higher wins); the single highest-priority non-stackable rule sets the price,
 * and every `stackable` rule then composes on top in priority order.
 */
export type PromotionScope = {
  brandIds?: string[]
  categoryIds?: string[]
  variantIds?: string[]
}

/** A promotion in the shape the resolver needs (DB row or a test fixture). */
export type PromotionRule = {
  id: string
  type: 'PERCENTAGE' | 'FIXED_AMOUNT'
  value: DecimalInput
  priority: number
  stackable: boolean
  isActive: boolean
  startsAt: Date | null
  endsAt: Date | null
  scope: PromotionScope | null
}

/** What a variant is, for scope matching. */
export type PromotionTarget = { variantId: string; brandId?: string | null; categoryId?: string | null }

export type PromotedPrice = { amount: number; listAmount: number; promotionIds: string[] }



/** Active = enabled and within [startsAt, endsAt) at `date` (end exclusive). */
export function isPromotionActiveAt(rule: Pick<PromotionRule, 'isActive' | 'startsAt' | 'endsAt'>, date: Date): boolean {
  if (!rule.isActive) return false
  if (rule.startsAt && rule.startsAt > date) return false
  if (rule.endsAt && rule.endsAt <= date) return false
  return true
}

/** Empty/absent scope matches all; otherwise any matching id (variant | brand | category) qualifies. */
export function promotionScopeMatches(scope: PromotionScope | null | undefined, target: PromotionTarget): boolean {
  if (!scope) return true
  const variantIds = scope.variantIds ?? []
  const brandIds = scope.brandIds ?? []
  const categoryIds = scope.categoryIds ?? []
  if (variantIds.length === 0 && brandIds.length === 0 && categoryIds.length === 0) return true
  if (variantIds.includes(target.variantId)) return true
  if (target.brandId && brandIds.includes(target.brandId)) return true
  if (target.categoryId && categoryIds.includes(target.categoryId)) return true
  return false
}

function applyRule(amount: string, rule: Pick<PromotionRule, 'type' | 'value'>): string {
  const discount = rule.type === 'PERCENTAGE' ? decimal(amount).mul(decimal(rule.value)).div(100) : decimal(rule.value)
  const next = decimal(amount).sub(discount)
  return money(next.isNegative() ? 0 : next)
}

/**
 * Pure resolver: apply the applicable promotions to a base amount. No DB.
 * Deterministic order: priority desc, then stable by id for ties.
 */
export function resolvePromotedAmountExact(
  base: { amount: DecimalInput },
  target: PromotionTarget,
  rules: PromotionRule[],
  date: Date,
): { amount: string; listAmount: string; promotionIds: string[] } {
  const applicable = rules
    .filter((r) => isPromotionActiveAt(r, date) && promotionScopeMatches(r.scope, target))
    .sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id))
  if (applicable.length === 0) return { amount: money(base.amount), listAmount: money(base.amount), promotionIds: [] }

  let amount = money(base.amount)
  const promotionIds: string[] = []

  // Highest-priority non-stackable rule (if any) sets the discounted price.
  const winner = applicable.find((r) => !r.stackable)
  if (winner) {
    amount = applyRule(amount, winner)
    promotionIds.push(winner.id)
  }
  // Every stackable rule composes on top, in priority order.
  for (const rule of applicable) {
    if (!rule.stackable) continue
    amount = applyRule(amount, rule)
    promotionIds.push(rule.id)
  }

  return { amount: money(amount), listAmount: money(base.amount), promotionIds }
}

type PromotionContext = { rules: PromotionRule[]; targets: Map<string, PromotionTarget> }

/** Load the store's promotions once plus each variant's brand/category for scope matching. */
export async function loadPromotionContext(
  input: { storeId: string; variantIds: string[] },
  client: Client = defaultPrisma,
): Promise<PromotionContext> {
  if (input.variantIds.length === 0 || !effectiveCapabilities().includes('promotions')) return { rules: [], targets: new Map() }
  const [rows, variants] = await Promise.all([
    client.promotion.findMany({ where: { storeId: input.storeId, isActive: true } }),
    client.productVariant.findMany({
      where: { id: { in: input.variantIds } },
      select: { id: true, product: { select: { brandId: true, categoryId: true } } },
    }),
  ])
  const rules: PromotionRule[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    value: r.value.toString(),
    priority: r.priority,
    stackable: r.stackable,
    isActive: r.isActive,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    scope: (r.scope as PromotionScope | null) ?? null,
  }))
  const targets = new Map<string, PromotionTarget>()
  for (const v of variants) targets.set(v.id, { variantId: v.id, brandId: v.product.brandId, categoryId: v.product.categoryId })
  return { rules, targets }
}

/** Numeric compatibility view. Pricing persistence uses the exact resolver. */
export function resolvePromotedAmount(base: { amount: DecimalInput }, target: PromotionTarget, rules: PromotionRule[], date: Date): PromotedPrice {
  const value = resolvePromotedAmountExact(base, target, rules, date)
  return { amount: Number(value.amount), listAmount: Number(value.listAmount), promotionIds: value.promotionIds }
}
