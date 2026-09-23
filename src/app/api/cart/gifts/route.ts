import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { prisma } from '@/lib/db'
import { getGiftOffers, giftOptions } from '@/lib/promotions/gifts'
import { getCartView } from '@/lib/cart/cart'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  const auth = await requireApiUser()
  if ('response' in auth) return auth.response
  const query = new URL(request.url).searchParams
  const cart = await prisma.cart.findUnique({ where: { userId: auth.user.id }, include: { items: true } })
  return NextResponse.json({ options: cart ? await giftOptions(auth.user, cart, query.get('promotionId') ?? '', (query.get('q') ?? '').slice(0, 200)) : [] })
}
const schema = z.object({ promotionId: z.string().min(1), variantId: z.string().min(1).max(128) }).strict()
export async function POST(request: Request) {
  const auth = await requireApiUser(undefined, 'promotions')
  if ('response' in auth) return auth.response
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  const saved = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Cart" WHERE "userId" = ${auth.user.id} AND "storeId" = ${auth.user.storeId} FOR UPDATE`
    const cart = await tx.cart.findUnique({ where: { userId: auth.user.id }, include: { items: true } })
    if (!cart) return false
    const selections = { ...((cart.giftSelections ?? {}) as Record<string, string>), [parsed.data.promotionId]: parsed.data.variantId }
    const offer = (await getGiftOffers(auth.user, { ...cart, giftSelections: selections }, tx)).find(o => o.id === parsed.data.promotionId)
    if (!offer?.quantity || (parsed.data.variantId !== 'SKIP' && !offer.gift)) return false
    await tx.cart.update({ where: { id: cart.id }, data: { giftSelections: selections, version: { increment: 1 } } })
    return true
  })
  return saved ? NextResponse.json(await getCartView(auth.user)) : NextResponse.json({ error: 'gift_unavailable' }, { status: 409 })
}
