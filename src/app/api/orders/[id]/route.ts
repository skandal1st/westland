import { hasInvoiceConfirmation } from '@/lib/orders/confirmation'
import { readCommercialSnapshot } from '@/lib/orders/commercial-snapshot'
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
    include: { manualConfirmation: true, items: true, export: { select: { status: true, connectionId: true, externalId: true, confirmedAt: true, attempts: true, submittedAt: true } } },
  })
  if (!order) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const invoice = await getCurrentInvoice({ storeId: user.storeId, orderId: order.id })
  return NextResponse.json({
    id: order.id,
    number: order.number,
    status: order.status,
    total: order.total.toFixed(2),
    currency: order.currency,
    comment: order.comment,
    createdAt: order.createdAt,
    cancellationRequestedAt: order.cancellationRequestedAt,
    providerDecisionMessage: order.providerDecisionMessage,
    manuallyConfirmed: !!order.manualConfirmation && hasInvoiceConfirmation(order, readCommercialSnapshot(order.commercialSnapshot, order)),
    erpConfirmed: !!order.export?.externalId && !!order.export?.confirmedAt,
    transferStarted: !!order.export && (order.export.attempts > 0 || !!order.export.externalId || !!order.export.submittedAt || ['PROCESSING', 'SUCCESS'].includes(order.export.status)),
    export: order.export?.status ?? null,
    items: order.items.map((i) => ({ sku: i.sku, sourceSku: i.sourceSku, name: i.productName, packaging: i.packaging, quantity: Number(i.quantity), unitPrice: i.unitPrice.toFixed(2), lineTotal: i.lineTotal.toFixed(2) })),
    invoice: invoice ? { id: invoice.id, number: invoice.number, version: invoice.version, issuedAt: invoice.issuedAt } : null,
  })
}
