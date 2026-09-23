import { z } from 'zod'
import { prisma } from '@/lib/db'
import { safeBannerHref } from './banner-link'
import { validBannerImage, readBannerAsset } from './assets'
export const bannerFields = z.object({
  name: z.string().trim().min(1).max(200), placement: z.enum(['HOME', 'CATALOG']),
  categoryId: z.string().min(1).nullable().optional(),
  brandId: z.string().min(1).nullable(), campaignId: z.string().min(1).nullable(),
  desktopImageUrl: z.string().max(2048).refine(validBannerImage).nullable(), mobileImageUrl: z.string().max(2048).refine(validBannerImage).nullable(),
  linkUrl: z.string().max(2048).refine(v => v === '' || safeBannerHref(v) !== null).nullable(),
  isActive: z.boolean(), sortOrder: z.number().int().min(0).max(100000), startsAt: z.coerce.date().nullable(), endsAt: z.coerce.date().nullable(),
})
export async function validateBanner(storeId: string, data: Partial<z.infer<typeof bannerFields>>) {
  if (data.startsAt && data.endsAt && data.startsAt >= data.endsAt) return 'invalid_dates'
  if (data.isActive && !data.desktopImageUrl) return 'image_required'
  const [brand, campaign, category] = await Promise.all([
    data.brandId ? prisma.brand.findFirst({ where: { id: data.brandId, storeId }, select: { id: true } }) : true,
    data.campaignId ? prisma.campaign.findFirst({ where: { id: data.campaignId, storeId }, select: { id: true } }) : true,
    data.categoryId ? prisma.category.findFirst({ where: { id: data.categoryId, storeId, mergedIntoId: null }, select: { id: true } }) : true,
  ])
  if (!brand || !campaign || !category) return 'invalid_relation'
  for (const url of [data.desktopImageUrl, data.mobileImageUrl]) {
    if (url?.startsWith('/api/content/assets/') && !await readBannerAsset(storeId, url.slice('/api/content/assets/'.length))) return 'image_not_found'
  }
  return null
}
