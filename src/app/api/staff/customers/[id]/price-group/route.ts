import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { assignBuyerPriceGroup } from '@/lib/pricing/assignment'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({ priceGroupId: z.string().min(1) })

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })

  const [customer, group] = await Promise.all([
    prisma.customer.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true } }),
    prisma.priceGroup.findFirst({ where: { id: parsed.data.priceGroupId, storeId: store.id }, select: { id: true } }),
  ])
  if (!customer || !group) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  await assignBuyerPriceGroup({ storeId: store.id, customerId: customer.id, priceGroupId: group.id, actor: auth.user })
  return NextResponse.json({ status: 'assigned' })
}
