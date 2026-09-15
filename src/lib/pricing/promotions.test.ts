import { describe, expect, it } from 'vitest'
import { isPromotionActiveAt, promotionScopeMatches, resolvePromotedAmount, type PromotionRule } from '@/lib/pricing/promotions'

const NOW = new Date('2026-06-15T12:00:00Z')

function rule(over: Partial<PromotionRule> & { id: string }): PromotionRule {
  return {
    type: 'PERCENTAGE', value: 10, priority: 100, stackable: false, isActive: true,
    startsAt: null, endsAt: null, scope: null, ...over,
  }
}

const variant = { variantId: 'v1', brandId: 'b1', categoryId: 'c1' }

describe('promotion activity window', () => {
  it('is inactive before startsAt and at/after endsAt (end exclusive)', () => {
    const r = { isActive: true, startsAt: new Date('2026-06-10'), endsAt: new Date('2026-06-20') }
    expect(isPromotionActiveAt(r, new Date('2026-06-09'))).toBe(false)
    expect(isPromotionActiveAt(r, new Date('2026-06-15'))).toBe(true)
    expect(isPromotionActiveAt({ ...r, endsAt: new Date('2026-06-15') }, new Date('2026-06-15'))).toBe(false)
  })

  it('honours the isActive flag regardless of window', () => {
    expect(isPromotionActiveAt({ isActive: false, startsAt: null, endsAt: null }, NOW)).toBe(false)
  })
})

describe('promotion scope matching', () => {
  it('empty/absent scope matches every variant', () => {
    expect(promotionScopeMatches(null, variant)).toBe(true)
    expect(promotionScopeMatches({}, variant)).toBe(true)
    expect(promotionScopeMatches({ brandIds: [], categoryIds: [], variantIds: [] }, variant)).toBe(true)
  })

  it('matches by brand, category or variant id; otherwise no match', () => {
    expect(promotionScopeMatches({ brandIds: ['b1'] }, variant)).toBe(true)
    expect(promotionScopeMatches({ categoryIds: ['c1'] }, variant)).toBe(true)
    expect(promotionScopeMatches({ variantIds: ['v1'] }, variant)).toBe(true)
    expect(promotionScopeMatches({ brandIds: ['other'] }, variant)).toBe(false)
  })
})

describe('promotion application to price', () => {
  it('applies a percentage discount', () => {
    const out = resolvePromotedAmount({ amount: 1000 }, variant, [rule({ id: 'p', value: 20 })], NOW)
    expect(out.amount).toBe(800)
    expect(out.listAmount).toBe(1000)
    expect(out.promotionIds).toEqual(['p'])
  })

  it('applies a fixed-amount discount and never goes below zero', () => {
    const out = resolvePromotedAmount({ amount: 100 }, variant, [rule({ id: 'p', type: 'FIXED_AMOUNT', value: 150 })], NOW)
    expect(out.amount).toBe(0)
  })

  it('ignores an expired promotion', () => {
    const expired = rule({ id: 'p', value: 50, endsAt: new Date('2026-01-01') })
    const out = resolvePromotedAmount({ amount: 1000 }, variant, [expired], NOW)
    expect(out.amount).toBe(1000)
    expect(out.promotionIds).toEqual([])
  })

  it('resolves overlapping non-stackable promotions by priority (highest wins, only one applies)', () => {
    const low = rule({ id: 'low', value: 10, priority: 1 })
    const high = rule({ id: 'high', value: 30, priority: 99 })
    const out = resolvePromotedAmount({ amount: 1000 }, variant, [low, high], NOW)
    expect(out.amount).toBe(700) // 30% wins, 10% not compounded
    expect(out.promotionIds).toEqual(['high'])
  })

  it('composes stackable promotions on top of the winning non-stackable one', () => {
    const base = rule({ id: 'base', value: 20, priority: 50, stackable: false })
    const extra = rule({ id: 'extra', value: 10, priority: 10, stackable: true })
    const out = resolvePromotedAmount({ amount: 1000 }, variant, [base, extra], NOW)
    // 1000 -20% = 800, then -10% stackable = 720
    expect(out.amount).toBe(720)
    expect(out.promotionIds).toEqual(['base', 'extra'])
  })

  it('does not apply promotions whose scope excludes the variant', () => {
    const other = rule({ id: 'p', value: 50, scope: { brandIds: ['other-brand'] } })
    const out = resolvePromotedAmount({ amount: 1000 }, variant, [other], NOW)
    expect(out.amount).toBe(1000)
    expect(out.promotionIds).toEqual([])
  })
})
