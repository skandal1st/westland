import { prisma } from '@/lib/db'

export type CatalogItem = {
  productId: string
  slug: string
  displayName: string
  description: string
  imageUrls: string[]
  sku: string | null
  packaging: string | null
  categoryId: string | null
  brandId: string | null
}

const defaultVariant = { where: { isDefault: true }, take: 1, orderBy: { sortOrder: 'asc' } } as const

function toItem(product: {
  id: string
  categoryId: string | null
  brandId: string | null
  canonicalName: string
  content: { slug: string; displayName: string; description: string; imageUrls: string[] } | null
  variants: { sku: string; packaging: string }[]
}): CatalogItem | null {
  if (!product.content) return null // canonical without overlay is not storefront-ready
  const variant = product.variants[0]
  return {
    productId: product.id,
    slug: product.content.slug,
    displayName: product.content.displayName,
    description: product.content.description,
    imageUrls: product.content.imageUrls,
    sku: variant?.sku ?? null,
    packaging: variant?.packaging ?? null,
    categoryId: product.categoryId,
    brandId: product.brandId,
  }
}

/** Storefront listing assembled from canonical identity + commerce overlay. */
export async function listCatalog(input: { storeId: string; take?: number; skip?: number }): Promise<{ items: CatalogItem[]; total: number }> {
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
        variants: { ...defaultVariant, select: { sku: true, packaging: true } },
      },
    }),
    prisma.product.count({ where }),
  ])
  return { items: rows.map(toItem).filter((item): item is CatalogItem => item !== null), total }
}

export async function getProductBySlug(storeId: string, slug: string): Promise<CatalogItem | null> {
  const content = await prisma.commerceProductContent.findUnique({
    where: { storeId_slug: { storeId, slug } },
    select: {
      slug: true, displayName: true, description: true, imageUrls: true,
      product: {
        select: {
          id: true, categoryId: true, brandId: true, canonicalName: true, status: true,
          variants: { ...defaultVariant, select: { sku: true, packaging: true } },
        },
      },
    },
  })
  if (!content || content.product.status !== 'ACTIVE') return null
  return toItem({ ...content.product, content })
}
