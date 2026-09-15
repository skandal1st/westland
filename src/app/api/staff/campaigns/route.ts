import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { invalidateContentCache } from '@/lib/content/read'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const campaignSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
    description: z.string().nullish(),
    priority: z.number().int().default(100),
    isActive: z.boolean().default(true),
    startsAt: z.coerce.date().nullish(),
    endsAt: z.coerce.date().nullish(),
  })
  .refine((v) => !(v.startsAt && v.endsAt) || v.startsAt < v.endsAt, { message: 'startsAt must be before endsAt', path: ['endsAt'] })

export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const campaigns = await prisma.campaign.findMany({
    where: { storeId: store.id },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true, name: true, slug: true, description: true, priority: true, isActive: true, startsAt: true, endsAt: true,
      _count: { select: { banners: true, promotions: true } },
    },
  })
  return NextResponse.json({ campaigns })
}

export async function POST(request: Request) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const parsed = campaignSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  try {
    const campaign = await prisma.campaign.create({ data: { storeId: store.id, ...parsed.data } })
    invalidateContentCache(store.id)
    return NextResponse.json({ id: campaign.id }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'conflict' }, { status: 409 })
  }
}
