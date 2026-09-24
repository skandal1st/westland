import { NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/authz'
import { prisma } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response

  const order = await prisma.order.findFirst({
    where: { id: params.id, storeId: auth.user.storeId },
    select: {
      id: true,
      number: true,
      total: true,
      currency: true,
      comment: true,
      items: {
        orderBy: { id: 'asc' },
        select: { id: true, sku: true, sourceSku: true, productName: true, packaging: true, quantity: true, unitPrice: true, lineTotal: true },
      },
    },
  })

  if (!order) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  return NextResponse.json({
    id: order.id,
    number: order.number,
    total: order.total.toFixed(2),
    currency: order.currency,
    comment: order.comment,
    items: order.items.map((item) => ({
      id: item.id,
      sku: item.sku,
      sourceSku: item.sourceSku,
      name: item.productName,
      packaging: item.packaging,
      quantity: item.quantity.toString(),
      unitPrice: item.unitPrice.toFixed(2),
      lineTotal: item.lineTotal.toFixed(2),
    })),
  }, { headers: { 'cache-control': 'private, no-store' } })
}
