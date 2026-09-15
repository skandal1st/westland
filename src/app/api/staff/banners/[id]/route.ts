import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { invalidateContentCache } from '@/lib/content/read'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    placement: z.enum(['HOME', 'CATALOG']).optional(),
    brandId: z.string().nullish(),
    campaignId: z.string().nullish(),
    desktopImageUrl: z.string().url().nullish(),
    mobileImageUrl: z.string().url().nullish(),
    linkUrl: z.string().nullish(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    startsAt: z.coerce.date().nullish(),
    endsAt: z.coerce.date().nullish(),
  })
  .refine((v) => !(v.startsAt && v.endsAt) || v.startsAt < v.endsAt, { message: 'startsAt must be before endsAt', path: ['endsAt'] })

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const existing = await prisma.siteBanner.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true } })
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  await prisma.siteBanner.update({ where: { id: existing.id }, data: parsed.data })
  invalidateContentCache(store.id)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const existing = await prisma.siteBanner.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true } })
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  await prisma.siteBanner.delete({ where: { id: existing.id } })
  invalidateContentCache(store.id)
  return NextResponse.json({ ok: true })
}
