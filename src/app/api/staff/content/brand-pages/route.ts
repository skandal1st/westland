import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { invalidateContentCache } from '@/lib/content/read'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const pageSchema = z.object({
  brandId: z.string().min(1),
  title: z.string().min(1),
  heroImageUrl: z.string().url().nullish(),
  body: z.unknown().optional(),
  isActive: z.boolean().default(true),
})

export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const pages = await prisma.brandPage.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, brandId: true, title: true, heroImageUrl: true, body: true, isActive: true, brand: { select: { name: true, slug: true } } },
  })
  return NextResponse.json({ pages })
}

export async function POST(request: Request) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const parsed = pageSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  // Brand must belong to this store; the brandId is unique so one page per brand.
  const brand = await prisma.brand.findFirst({ where: { id: parsed.data.brandId, storeId: store.id }, select: { id: true } })
  if (!brand) return NextResponse.json({ error: 'invalid_brand' }, { status: 400 })

  const { body, ...rest } = parsed.data
  try {
    const page = await prisma.brandPage.create({ data: { storeId: store.id, ...rest, body: (body ?? undefined) as any } })
    invalidateContentCache(store.id)
    return NextResponse.json({ id: page.id }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'conflict' }, { status: 409 })
  }
}
