import { categoryScope, flattenCategories, type CategoryNode } from './tree'
import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import { priceVariantsInContext, type ResolvedPrice } from '@/lib/pricing'
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
  sourceSku?: string | null
  packaging: string | null
  categoryId: string | null
  brandId: string | null
  price: ResolvedPrice | null
  availability: { available: number; stale: boolean } | null
}

const defaultVariant = { where: { isDefault: true, status: 'ACTIVE' }, take: 1, orderBy: { sortOrder: 'asc' } } as const
const STALE_AFTER_MS = 1000 * 60 * 60 * 24 // 24h

type ProductRow = {
  id: string
  categoryId: string | null
  brandId: string | null
  canonicalName: string
  content: { slug: string; displayName: string; description: string; imageUrls: string[] } | null
  variants: { id: string; sku: string; sourceSku: string | null; packaging: string }[]
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
    sourceSku: variant?.sourceSku ?? null,
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
export type CatalogFilters = { storeId: string; categorySlug?: string | null; brandSlug?: string | null; query?: string | null; categoryIds?: string[] }
export function catalogWhere(input: CatalogFilters): Prisma.ProductWhereInput {
  // Search text is literal, including SQL LIKE metacharacters in supplier SKUs.
  const query = input.query?.trim().replace(/[\\%_]/g, '\\$&')
  return {
    storeId: input.storeId,
    status: 'ACTIVE' as const,
    content: { isNot: null },
    AND: [
      // Products in a hidden category are excluded from the storefront entirely.
      { OR: [{ categoryId: null }, { category: { is: { hidden: false } } }] },
      ...(input.categoryIds ? [input.categorySlug ? { categoryId: { in: input.categoryIds } } : { OR: [{ categoryId: null }, { categoryId: { in: input.categoryIds } }] }] : input.categorySlug ? [{ category: { is: { slug: input.categorySlug } } }] : []),
      ...(input.brandSlug ? [{ brand: { is: { slug: input.brandSlug } } }] : []),
      ...(query ? [{ OR: [
        { canonicalName: { contains: query, mode: 'insensitive' as const } },
        { content: { is: { displayName: { contains: query, mode: 'insensitive' as const } } } },
        { variants: { some: { isDefault: true, status: 'ACTIVE' as const, OR: [
          { sku: { contains: query, mode: 'insensitive' as const } },
          { sourceSku: { contains: query, mode: 'insensitive' as const } },
        ] } } },
      ] }] : []),
    ],
  }
}

export async function listCatalog(input: {
  storeId: string
  take?: number
  skip?: number
  groupId?: string | null
  channelId?: string | null
  categorySlug?: string | null
  brandSlug?: string | null
  query?: string | null
  date?: Date
}): Promise<{ items: CatalogItem[]; total: number }> {
  const take = Math.min(Math.max(input.take ?? 50, 1), 100)
  const skip = Math.max(input.skip ?? 0, 0)
  const scope = await categoryScope(input.storeId, input.categorySlug)
  const where = catalogWhere({ ...input, categoryIds: scope.ids })
  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
      skip,
      select: {
        id: true, categoryId: true, brandId: true, canonicalName: true,
        content: { select: { slug: true, displayName: true, description: true, imageUrls: true } },
        variants: { ...defaultVariant, select: { id: true, sku: true, sourceSku: true, packaging: true } },
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
    if (a) item.availability = { available: a.available, stale: a.sourceUpdatedAt ? now - a.sourceUpdatedAt.getTime() > STALE_AFTER_MS || a.sourceUpdatedAt.getTime() > now : true }
  }

  return { items, total }
}

export type CatalogNav = { categories: CategoryNode[]; brands: { name: string; slug: string }[] }
export async function listCatalogNav(storeId: string): Promise<CatalogNav> {
  const facets = await catalogFacets({ storeId })
  return { categories: facets.tree, brands: facets.brands }
}

export async function getProductBySlug(storeId: string, slug: string): Promise<CatalogItem | null> {
  const content = await prisma.commerceProductContent.findUnique({
    where: { storeId_slug: { storeId, slug } },
    select: {
      slug: true, displayName: true, description: true, imageUrls: true,
      product: {
        select: {
          id: true, categoryId: true, brandId: true, canonicalName: true, status: true,
          variants: { ...defaultVariant, select: { id: true, sku: true, sourceSku: true, packaging: true } },
        },
      },
    },
  })
  if (!content || content.product.status !== 'ACTIVE') return null
  if (content.product.categoryId && !(await categoryScope(storeId)).ids.includes(content.product.categoryId)) return null
  return toItem({ ...content.product, content })
}

export type CatalogFacet = { name: string; slug: string; count: number }
export async function catalogFacets(input: CatalogFilters) {
  const scope = await categoryScope(input.storeId, input.categorySlug)
  const allIds = flattenCategories(scope.tree).map(n=>n.id)
  const [categoryCounts, brandCounts] = await Promise.all([
    prisma.product.groupBy({ by: ['categoryId'], where: catalogWhere({ ...input, categorySlug: undefined, categoryIds: allIds }), _count: { _all: true } }),
    prisma.product.groupBy({ by: ['brandId'], where: catalogWhere({ ...input, categoryIds: scope.ids }), _count: { _all: true } }),
  ])
  const counts = new Map(categoryCounts.flatMap(c => c.categoryId ? [[c.categoryId, c._count._all] as const] : []))
  const rollup = (nodes: CategoryNode[]): CategoryNode[] => nodes.map(n => { const children=rollup(n.children);return {...n,children,count:(counts.get(n.id)??0)+children.reduce((v,c)=>v+c.count,0)} }).filter(n=>n.count>0)
  const tree = rollup(scope.tree)
  const brands = await prisma.brand.findMany({ where: { storeId: input.storeId, id: { in: brandCounts.flatMap(b=>b.brandId?[b.brandId]:[]) } }, orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true } })
  const bc = new Map(brandCounts.map(b=>[b.brandId,b._count._all]))
  const selected = scope.trail.at(-1)
  const brand = input.brandSlug ? await prisma.brand.findFirst({where:{storeId:input.storeId,slug:input.brandSlug},select:{name:true,slug:true}}) : null
  return { tree, trail: scope.trail.map(n=>({id:n.id,name:n.name,slug:n.slug})), categories: tree.map(n=>({name:n.name,slug:n.slug,count:n.count})), brands: brands.map(b=>({name:b.name,slug:b.slug,count:bc.get(b.id)??0})), category: selected ? { name:selected.name,slug:selected.slug } : null, brand }
}
