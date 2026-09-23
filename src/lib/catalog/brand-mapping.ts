import { sourceGroupPath } from './group-mapping'
import type { Prisma } from '@prisma/client'

export type BrandAncestor = { id: string; name: string }
/** Provider records ancestry as evidence; the locked source config decides the current staff mapping. */
export function mappedBrand(raw: Record<string, unknown>, config: Prisma.JsonValue): BrandAncestor | null | undefined {
  const path = sourceGroupPath(raw, config)
  if (!path.length && !Array.isArray(raw.brandPath)) return undefined
  const settings = (config ?? {}) as Record<string, unknown>
  const selected = new Set(Array.isArray(settings.brandGroups) ? settings.brandGroups : [])
  for (const item of path) {
    if (item && typeof item.id === 'string' && typeof item.name === 'string' && selected.has(item.id)) return { id: item.id, name: item.name }
  }
  return null
}
