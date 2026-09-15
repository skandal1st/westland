import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const scopeSchema = z
  .object({
    brandIds: z.array(z.string()).optional(),
    categoryIds: z.array(z.string()).optional(),
    variantIds: z.array(z.string()).optional(),
  })
  .nullish()

const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    campaignId: z.string().nullish(),
    type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).optional(),
    value: z.number().positive().optional(),
    priority: z.number().int().optional(),
    stackable: z.boolean().optional(),
    isActive: z.boolean().optional(),
    startsAt: z.coerce.date().nullish(),
    endsAt: z.coerce.date().nullish(),
    scope: scopeSchema,
  })
  .refine((v) => !(v.startsAt && v.endsAt) || v.startsAt < v.endsAt, { message: 'startsAt must be before endsAt', path: ['endsAt'] })

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const existing = await prisma.promotion.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true } })
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  const { scope, ...rest } = parsed.data
  await prisma.promotion.update({
    where: { id: existing.id },
    data: { ...rest, ...(scope !== undefined ? { scope: (scope ?? undefined) as any } : {}) },
  })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const existing = await prisma.promotion.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true } })
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  await prisma.promotion.delete({ where: { id: existing.id } })
  return NextResponse.json({ ok: true })
}
