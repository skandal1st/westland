import { NextResponse } from 'next/server'
import { bannerFields, validateBanner } from '@/lib/content/banner-validation'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { invalidateContentCache } from '@/lib/content/read'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const patchSchema = bannerFields.partial()

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'content')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const existing = await prisma.siteBanner.findFirst({ where: { id: params.id, storeId: store.id } })
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  const error = await validateBanner(store.id, { ...existing, ...parsed.data })
  if (error) return NextResponse.json({ error }, { status: 400 })
  await prisma.siteBanner.update({ where: { id: existing.id }, data: parsed.data })
  invalidateContentCache(store.id)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'content')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const existing = await prisma.siteBanner.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true } })
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  await prisma.siteBanner.delete({ where: { id: existing.id } })
  invalidateContentCache(store.id)
  return NextResponse.json({ ok: true })
}
