import type { BannerPlacement, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { safeBannerHref } from '@/lib/content/banner-link'

type Client = PrismaClient

/**
 * Storefront content read-model (plan §M9). Banners/pages/blocks are read far
 * more than they change, so results are cached in-process with a short TTL and
 * explicitly invalidated by backoffice mutations (see invalidateContentCache).
 * Activity is date-windowed: active = enabled and within [startsAt, endsAt).
 */
export type ActiveBanner = {
  id: string
  name: string
  placement: BannerPlacement
  desktopImageUrl: string | null
  mobileImageUrl: string | null
  linkUrl: string | null
  brand: { slug: string; name: string } | null
}

export type StorefrontBrandPage = {
  brand: { slug: string; name: string; logoUrl: string | null }
  title: string
  heroImageUrl: string | null
  body: unknown
}

export type StorefrontContentBlock = { key: string; title: string | null; body: unknown }

const TTL_MS = 60_000
type CacheEntry<T> = { value: T; expires: number }
const cache = new Map<string, CacheEntry<unknown>>()

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value as T)
  return load().then((value) => {
    cache.set(key, { value, expires: Date.now() + TTL_MS })
    return value
  })
}

/** Drop all cached content for a store after a backoffice mutation. */
export function invalidateContentCache(storeId?: string): void {
  if (!storeId) return cache.clear()
  for (const key of Array.from(cache.keys())) if (key.includes(storeId)) cache.delete(key)
}

function withinWindow(row: { startsAt: Date | null; endsAt: Date | null }, date: Date): boolean {
  if (row.startsAt && row.startsAt > date) return false
  if (row.endsAt && row.endsAt <= date) return false
  return true
}

export async function getActiveBanners(
  input: { storeId: string; placement: BannerPlacement; date?: Date },
  client: Client = defaultPrisma,
): Promise<ActiveBanner[]> {
  const date = input.date ?? new Date()
  // Date-window filtering is done in memory so the cached row set stays reusable
  // across the TTL window regardless of the exact `now`.
  const rows = await cached(`banners:${input.storeId}:${input.placement}`, () =>
    client.siteBanner.findMany({
      where: { storeId: input.storeId, placement: input.placement, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, name: true, placement: true, desktopImageUrl: true, mobileImageUrl: true, linkUrl: true,
        startsAt: true, endsAt: true,
        brand: { select: { slug: true, name: true } },
      },
    }),
  )
  return rows
    .filter((row) => withinWindow(row, date))
    .map((row) => ({
      id: row.id, name: row.name, placement: row.placement,
      desktopImageUrl: row.desktopImageUrl, mobileImageUrl: row.mobileImageUrl, linkUrl: safeBannerHref(row.linkUrl),
      brand: row.brand ? { slug: row.brand.slug, name: row.brand.name } : null,
    }))
}

export async function getBrandPage(
  input: { storeId: string; slug: string },
  client: Client = defaultPrisma,
): Promise<StorefrontBrandPage | null> {
  return cached(`brandpage:${input.storeId}:${input.slug}`, async () => {
    const brand = await client.brand.findUnique({
      where: { storeId_slug: { storeId: input.storeId, slug: input.slug } },
      select: { slug: true, name: true, logoUrl: true, page: true },
    })
    if (!brand || !brand.page || !brand.page.isActive) return null
    return {
      brand: { slug: brand.slug, name: brand.name, logoUrl: brand.logoUrl },
      title: brand.page.title,
      heroImageUrl: brand.page.heroImageUrl,
      body: brand.page.body ?? null,
    }
  })
}

export async function getContentBlocks(
  input: { storeId: string; placement: string },
  client: Client = defaultPrisma,
): Promise<StorefrontContentBlock[]> {
  return cached(`blocks:${input.storeId}:${input.placement}`, async () => {
    const rows = await client.contentBlock.findMany({
      where: { storeId: input.storeId, placement: input.placement, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { key: true, title: true, body: true },
    })
    return rows.map((row) => ({ key: row.key, title: row.title, body: row.body ?? null }))
  })
}
