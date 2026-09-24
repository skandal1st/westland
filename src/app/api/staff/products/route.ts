import type { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Backoffice list of canonical products with their overlay + default variant. */
export async function GET(request: Request) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response

  const url = new URL(request.url)
  const take = Number(url.searchParams.get('take') ?? '50')
  const skip = Number(url.searchParams.get('skip') ?? '0')
  if (!Number.isSafeInteger(take) || take < 1 || take > 100 || !Number.isSafeInteger(skip) || skip < 0 || skip > 2147483647) return NextResponse.json({ error: 'invalid_pagination' }, { status: 400 })
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
  const store = await getActiveStore()

  const where: Prisma.ProductWhereInput = { storeId: store.id, ...(url.searchParams.get('id') ? { id: url.searchParams.get('id')! } : {}), ...(q ? { OR: [
    { canonicalName: { contains: q, mode: 'insensitive' } },
    { content: { displayName: { contains: q, mode: 'insensitive' } } },
    { variants: { some: { OR: [{ sku: { contains: q, mode: 'insensitive' } }, { sourceSku: { contains: q, mode: 'insensitive' } }] } } },
  ] } : {}) }
  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take,
      skip,
      select: {
        id: true, canonicalName: true, status: true,
        content: { select: { displayName: true, slug: true, description: true, attributes: true, updatedById: true } },
        variants: { where: { isDefault: true }, take: 1, select: { sku: true, sourceSku: true, packaging: true } },
      },
    }),
    prisma.product.count({ where }),
  ])

  return NextResponse.json({
    products: products.map((p) => ({
      id: p.id,
      canonicalName: p.canonicalName,
      status: p.status,
      displayName: p.content?.displayName ?? null,
      slug: p.content?.slug ?? null,
      description: p.content?.description ?? '',
      attributes: p.content?.attributes && !Array.isArray(p.content.attributes) && typeof p.content.attributes === 'object'
        ? Object.fromEntries(Object.entries(p.content.attributes).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      manuallyEdited: Boolean(p.content?.updatedById),
      sku: p.variants[0]?.sku ?? null,
      sourceSku: p.variants[0]?.sourceSku ?? null,
      packaging: p.variants[0]?.packaging ?? null,
    })),
    total,
  })
}
