import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { invalidateContentCache } from '@/lib/content/read'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  heroImageUrl: z.string().url().nullish(),
  body: z.unknown().optional(),
  isActive: z.boolean().optional(),
})

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const existing = await prisma.brandPage.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true } })
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  const { body, ...rest } = parsed.data
  await prisma.brandPage.update({ where: { id: existing.id }, data: { ...rest, ...(body !== undefined ? { body: (body ?? undefined) as any } : {}) } })
  invalidateContentCache(store.id)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const existing = await prisma.brandPage.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true } })
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  await prisma.brandPage.delete({ where: { id: existing.id } })
  invalidateContentCache(store.id)
  return NextResponse.json({ ok: true })
}
