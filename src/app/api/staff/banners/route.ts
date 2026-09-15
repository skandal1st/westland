import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { invalidateContentCache } from '@/lib/content/read'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bannerSchema = z
  .object({
    name: z.string().min(1),
    placement: z.enum(['HOME', 'CATALOG']).default('CATALOG'),
    brandId: z.string().nullish(),
    campaignId: z.string().nullish(),
    desktopImageUrl: z.string().url().nullish(),
    mobileImageUrl: z.string().url().nullish(),
    linkUrl: z.string().nullish(),
    isActive: z.boolean().default(true),
    sortOrder: z.number().int().default(0),
    startsAt: z.coerce.date().nullish(),
    endsAt: z.coerce.date().nullish(),
  })
  .refine((v) => !(v.startsAt && v.endsAt) || v.startsAt < v.endsAt, { message: 'startsAt must be before endsAt', path: ['endsAt'] })

export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const banners = await prisma.siteBanner.findMany({
    where: { storeId: store.id },
    orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }],
    select: {
      id: true, name: true, placement: true, brandId: true, campaignId: true,
      desktopImageUrl: true, mobileImageUrl: true, linkUrl: true, isActive: true, sortOrder: true, startsAt: true, endsAt: true,
      brand: { select: { name: true } },
    },
  })
  return NextResponse.json({ banners })
}

export async function POST(request: Request) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const parsed = bannerSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  const banner = await prisma.siteBanner.create({ data: { storeId: store.id, ...parsed.data } })
  invalidateContentCache(store.id)
  return NextResponse.json({ id: banner.id }, { status: 201 })
}
