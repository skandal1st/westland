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

const promotionSchema = z
  .object({
    name: z.string().min(1),
    campaignId: z.string().nullish(),
    type: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']).default('PERCENTAGE'),
    value: z.number().positive(),
    priority: z.number().int().default(100),
    stackable: z.boolean().default(false),
    isActive: z.boolean().default(true),
    startsAt: z.coerce.date().nullish(),
    endsAt: z.coerce.date().nullish(),
    scope: scopeSchema,
  })
  .refine((v) => !(v.startsAt && v.endsAt) || v.startsAt < v.endsAt, { message: 'startsAt must be before endsAt', path: ['endsAt'] })
  .refine((v) => v.type !== 'PERCENTAGE' || v.value <= 100, { message: 'percentage must be <= 100', path: ['value'] })

export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const promotions = await prisma.promotion.findMany({
    where: { storeId: store.id },
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true, name: true, campaignId: true, type: true, value: true, priority: true, stackable: true,
      isActive: true, startsAt: true, endsAt: true, scope: true,
    },
  })
  return NextResponse.json({ promotions: promotions.map((p) => ({ ...p, value: Number(p.value) })) })
}

export async function POST(request: Request) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'promotions')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const parsed = promotionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  const { scope, ...rest } = parsed.data
  const promotion = await prisma.promotion.create({ data: { storeId: store.id, ...rest, scope: (scope ?? undefined) as any } })
  return NextResponse.json({ id: promotion.id }, { status: 201 })
}
