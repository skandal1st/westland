import { NextResponse } from 'next/server'
import { bannerFields, validateBanner } from '@/lib/content/banner-validation'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { invalidateContentCache } from '@/lib/content/read'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bannerSchema = bannerFields.partial()

export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const banners = await prisma.siteBanner.findMany({
    where: { storeId: store.id },
    orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }],
    select: {
      id: true, name: true, placement: true, categoryId: true, category: { select: { name: true } }, brandId: true, campaignId: true,
      desktopImageUrl: true, mobileImageUrl: true, linkUrl: true, isActive: true, sortOrder: true, startsAt: true, endsAt: true,
      brand: { select: { name: true } },
    },
  })
  return NextResponse.json({ banners })
}

export async function POST(request: Request) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'content')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const parsed = bannerSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  const data = { name: '', placement: 'CATALOG' as const, isActive: false, ...parsed.data }
  if (!data.name) return NextResponse.json({ error: 'name_required' }, { status: 400 })
  const error = await validateBanner(store.id, data)
  if (error) return NextResponse.json({ error }, { status: 400 })
  const banner = await prisma.siteBanner.create({ data: { storeId: store.id, ...data } })
  invalidateContentCache(store.id)
  return NextResponse.json({ id: banner.id }, { status: 201 })
}
