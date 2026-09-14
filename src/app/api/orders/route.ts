import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/authz'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The buyer's own orders (business status + export status). */
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const orders = await prisma.order.findMany({
    where: { storeId: user.storeId, userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, number: true, status: true, total: true, currency: true, createdAt: true, export: { select: { status: true, externalId: true } }, invoices: { where: { status: 'ISSUED' }, select: { id: true }, take: 1 } },
  })
  return NextResponse.json({
    orders: orders.map((o) => ({ id: o.id, number: o.number, status: o.status, total: Number(o.total), currency: o.currency, createdAt: o.createdAt, export: o.export?.status ?? null, hasInvoice: o.invoices.length > 0 })),
  })
}
