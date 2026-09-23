import { hasInvoiceConfirmation } from '@/lib/orders/confirmation'
import { readCommercialSnapshot } from '@/lib/orders/commercial-snapshot'
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
    select: { storeId: true, commercialSnapshot: true, manualConfirmation: true, id: true, number: true, status: true, total: true, currency: true, createdAt: true, cancellationRequestedAt: true, providerDecisionMessage: true, export: { select: { status: true, connectionId: true, externalId: true, attempts: true, submittedAt: true, confirmedAt: true } }, invoices: { where: { status: 'ISSUED' }, select: { id: true }, take: 1 } },
  })
  return NextResponse.json({
    orders: orders.map((o) => ({ id: o.id, number: o.number, status: o.status, total: o.total.toFixed(2), currency: o.currency, createdAt: o.createdAt, cancellationRequestedAt: o.cancellationRequestedAt, providerDecisionMessage: o.providerDecisionMessage, manuallyConfirmed: !!o.manualConfirmation && hasInvoiceConfirmation(o, readCommercialSnapshot(o.commercialSnapshot, o)), erpConfirmed: !!o.export?.externalId && !!o.export?.confirmedAt, transferStarted: !!o.export && (o.export.attempts > 0 || !!o.export.externalId || !!o.export.submittedAt || o.export.status === 'PROCESSING'), export: o.export?.status ?? null, hasInvoice: o.invoices.length > 0 })),
  })
}
