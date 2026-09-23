import { hasInvoiceConfirmation } from '@/lib/orders/confirmation'
import { readCommercialSnapshot } from '@/lib/orders/commercial-snapshot'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Backoffice order list showing business status and integration/export status separately. */
export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const orders = await prisma.order.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true, storeId: true, commercialSnapshot: true, number: true, status: true, total: true, currency: true, createdAt: true, cancellationRequestedAt: true, providerDecisionMessage: true,
      manualConfirmation: true,
      customer: { select: { legalName: true } },
      export: { select: { status: true, connectionId: true, externalId: true, attempts: true, lastError: true, confirmedAt: true } },
      invoices: { where: { status: 'ISSUED' }, orderBy: { version: 'desc' }, take: 1, select: { number: true, version: true } },
    },
  })
  return NextResponse.json({
    orders: orders.map((o) => ({
      id: o.id, number: o.number, status: o.status, total: o.total.toFixed(2), currency: o.currency, createdAt: o.createdAt,
      customer: readCommercialSnapshot(o.commercialSnapshot, o)?.buyer.legalName ?? o.customer.legalName, cancellationRequestedAt: o.cancellationRequestedAt, providerDecisionMessage: o.providerDecisionMessage,
      canIssueInvoice: hasInvoiceConfirmation(o, readCommercialSnapshot(o.commercialSnapshot, o)),
      canManuallyConfirm: ['SUBMITTED','CONFIRMED'].includes(o.status) && o.export?.status === 'DELIVERED' && !o.export.confirmedAt && !o.manualConfirmation && !o.cancellationRequestedAt && !!readCommercialSnapshot(o.commercialSnapshot, o),
      manualConfirmation: o.manualConfirmation ? { documentNumber: o.manualConfirmation.documentNumber, documentDate: o.manualConfirmation.documentDate, confirmedAt: o.manualConfirmation.confirmedAt, revoked: !!o.manualConfirmation.revokedAt } : null,
      export: o.export ? { status: o.export.status, externalId: o.export.externalId, attempts: o.export.attempts, lastError: o.export.lastError } : null,
      invoice: o.invoices[0] ? { number: o.invoices[0].number, version: o.invoices[0].version } : null,
    })),
  })
}
