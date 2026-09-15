import { prisma } from '@/lib/db'
import { priceVariantsInContext } from '@/lib/pricing'
import { availabilityForVariants } from '@/lib/pricing/availability'
import { loadStoreProfile } from '@/lib/store-profile'

export type CatalogItem = {
  productId: string
  variantId: string | null
  slug: string
  displayName: string
  description: string
  imageUrls: string[]
  sku: string | null
  packaging: string | null
  categoryId: string | null
  brandId: string | null
  price: { amount: number; currency: string } | null
  availability: { available: number; stale: boolean } | null
}

const defaultVariant = { where: { isDefault: true }, take: 1, orderBy: { sortOrder: 'asc' } } as const
const STALE_AFTER_MS = 1000 * 60 * 60 * 24 // 24h

type ProductRow = {
  id: string
  categoryId: string | null
  brandId: string | null
  canonicalName: string
  content: { slug: string; displayName: string; description: string; imageUrls: string[] } | null
  variants: { id: string; sku: string; packaging: string }[]
}

function toItem(product: ProductRow): CatalogItem | null {
  if (!product.content) return null // canonical without overlay is not storefront-ready
  const variant = product.variants[0]
  return {
    productId: product.id,
    variantId: variant?.id ?? null,
    slug: product.content.slug,
    displayName: product.content.displayName,
    description: product.content.description,
    imageUrls: product.content.imageUrls,
    sku: variant?.sku ?? null,
    packaging: variant?.packaging ?? null,
    categoryId: product.categoryId,
    brandId: product.brandId,
    price: null,
    availability: null,
  }
}

/**
 * Storefront listing assembled from canonical identity + commerce overlay, then
 * enriched with contextual price (buyer group / channel) and availability (the
 * channel projection). Price/availability come from projections/entries — never
 * a synchronous provider call.
 */
export async function listCatalog(input: {
  storeId: string
  take?: number
  skip?: number
  groupId?: string | null
  channelId?: string | null
  date?: Date
}): Promise<{ items: CatalogItem[]; total: number }> {
  const take = Math.min(Math.max(input.take ?? 50, 1), 100)
  const skip = Math.max(input.skip ?? 0, 0)
  const where = { storeId: input.storeId, status: 'ACTIVE' as const }
  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      select: {
        id: true, categoryId: true, brandId: true, canonicalName: true,
        content: { select: { slug: true, displayName: true, description: true, imageUrls: true } },
        variants: { ...defaultVariant, select: { id: true, sku: true, packaging: true } },
      },
    }),
    prisma.product.count({ where }),
  ])

  const items = rows.map(toItem).filter((item): item is CatalogItem => item !== null)
  const variantIds = items.map((item) => item.variantId).filter((id): id is string => id !== null)

  const prices = await priceVariantsInContext({ storeId: input.storeId, variantIds, groupId: input.groupId, channelId: input.channelId, date: input.date, promotions: loadStoreProfile().modules.promotions })
  const availability = input.channelId ? await availabilityForVariants({ variantIds, channelId: input.channelId }) : new Map()
  const now = Date.now()

  for (const item of items) {
    if (!item.variantId) continue
    item.price = prices.get(item.variantId) ?? null
    const a = availability.get(item.variantId)
    if (a) item.availability = { available: a.available, stale: a.sourceUpdatedAt ? now - a.sourceUpdatedAt.getTime() > STALE_AFTER_MS : false }
  }

  return { items, total }
}

export async function getProductBySlug(storeId: string, slug: string): Promise<CatalogItem | null> {
  const content = await prisma.commerceProductContent.findUnique({
    where: { storeId_slug: { storeId, slug } },
    select: {
      slug: true, displayName: true, description: true, imageUrls: true,
      product: {
        select: {
          id: true, categoryId: true, brandId: true, canonicalName: true, status: true,
          variants: { ...defaultVariant, select: { id: true, sku: true, packaging: true } },
        },
      },
    },
  })
  if (!content || content.product.status !== 'ACTIVE') return null
  return toItem({ ...content.product, content })
}
