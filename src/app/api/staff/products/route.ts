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
  const take = Math.min(Math.max(Number(url.searchParams.get('take') ?? '50'), 1), 100)
  const skip = Math.max(Number(url.searchParams.get('skip') ?? '0'), 0)
  const store = await getActiveStore()

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
      select: {
        id: true, canonicalName: true, status: true,
        content: { select: { displayName: true, slug: true, description: true } },
        variants: { where: { isDefault: true }, take: 1, select: { sku: true, packaging: true } },
      },
    }),
    prisma.product.count({ where: { storeId: store.id } }),
  ])

  return NextResponse.json({
    products: products.map((p) => ({
      id: p.id,
      canonicalName: p.canonicalName,
      status: p.status,
      displayName: p.content?.displayName ?? null,
      slug: p.content?.slug ?? null,
      description: p.content?.description ?? '',
      sku: p.variants[0]?.sku ?? null,
      packaging: p.variants[0]?.packaging ?? null,
    })),
    total,
  })
}
