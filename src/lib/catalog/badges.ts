export const PRODUCT_BADGES = ['HIT', 'NEW', 'DISCONTINUED', 'LIMITED'] as const

export type ProductBadge = (typeof PRODUCT_BADGES)[number]

export const PRODUCT_BADGE_LABELS: Record<ProductBadge, string> = {
  HIT: 'Хит',
  NEW: 'Новинка',
  DISCONTINUED: 'Выводится',
  LIMITED: 'Лимитка',
}

export function parseProductBadges(value: unknown): ProductBadge[] {
  const selected = new Set(
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
  )
  return PRODUCT_BADGES.filter((badge) => selected.has(badge))
}
