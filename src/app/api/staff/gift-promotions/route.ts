import { effectiveCapabilities } from '@/lib/capabilities'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { prisma } from '@/lib/db'
import { giftRuleSchema, validateGiftRule } from '@/lib/promotions/gifts'
export const dynamic = 'force-dynamic'
const schema = z.object({ id: z.string().optional(), name: z.string().trim().min(1).max(200), isActive: z.boolean(), startsAt: z.coerce.date().nullable(), endsAt: z.coerce.date().nullable(), rule: giftRuleSchema }).strict().refine(v => !v.startsAt || !v.endsAt || v.startsAt < v.endsAt)
export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  return NextResponse.json({ enabled: effectiveCapabilities().includes('promotions'), promotions: await prisma.giftPromotion.findMany({ where: { storeId: store.id }, orderBy: { createdAt: 'desc' } }) })
}
export async function POST(request: Request) {
  const auth = await requireApiUser(['ADMIN'], 'promotions')
  if ('response' in auth) return auth.response
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_rule' }, { status: 400 })
  const store = await getActiveStore()
  const { id, ...data } = parsed.data
  const result = await prisma.$transaction(async tx => {
    // Same lock as category merge: references in rules remain valid after concurrent edits.
    await tx.$queryRaw`SELECT id FROM "Category" WHERE "storeId" = ${store.id} ORDER BY id FOR UPDATE`
    if (!await validateGiftRule(store.id, data.rule, tx)) return null
    if (id && !await tx.giftPromotion.findFirst({ where: { id, storeId: store.id } })) return null
    const result = id ? await tx.giftPromotion.update({ where: { id }, data }) : await tx.giftPromotion.create({ data: { storeId: store.id, ...data } })
    await tx.auditEntry.create({ data: { storeId: store.id, actorId: auth.user.id, action: 'GiftPromotionSaved', targetType: 'GiftPromotion', targetId: result.id, metadata: { name: data.name, isActive: data.isActive } } })
    return result
  })
  return result ? NextResponse.json({ promotion: result }) : NextResponse.json({ error: 'invalid_reference' }, { status: 400 })
}
export async function DELETE(request: Request) {
  const auth = await requireApiUser(['ADMIN'], 'promotions')
  if ('response' in auth) return auth.response
  const store = await getActiveStore(), id = new URL(request.url).searchParams.get('id') ?? ''
  const result = await prisma.giftPromotion.deleteMany({ where: { id, storeId: store.id } })
  return NextResponse.json({ ok: !!result.count })
}
