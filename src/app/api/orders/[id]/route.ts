import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/authz'
import { getCurrentInvoice } from '@/lib/invoices/invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A single order owned by the buyer, with its lines and current invoice (if issued). */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const order = await prisma.order.findFirst({
    where: { id: params.id, storeId: user.storeId, userId: user.id },
    include: { items: true, export: { select: { status: true } } },
  })
  if (!order) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const invoice = await getCurrentInvoice({ storeId: user.storeId, orderId: order.id })
  return NextResponse.json({
    id: order.id,
    number: order.number,
    status: order.status,
    total: Number(order.total),
    currency: order.currency,
    comment: order.comment,
    createdAt: order.createdAt,
    export: order.export?.status ?? null,
    items: order.items.map((i) => ({ sku: i.sku, name: i.productName, packaging: i.packaging, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice), lineTotal: Number(i.lineTotal) })),
    invoice: invoice ? { id: invoice.id, number: invoice.number, version: invoice.version, issuedAt: invoice.issuedAt } : null,
  })
}
