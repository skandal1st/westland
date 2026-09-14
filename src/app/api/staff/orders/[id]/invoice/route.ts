import { NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { issueInvoice, InvoiceError } from '@/lib/invoices/invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS: Record<InvoiceError['code'], number> = {
  ORDER_NOT_FOUND: 404,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  NO_SELLER_REQUISITES: 409,
}

/**
 * Issue (or reissue) the invoice for an order. Staff/admin only. A reissue
 * creates a new immutable version and VOIDs the previous one — audited as
 * InvoiceIssued / InvoiceReissued.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  try {
    const invoice = await issueInvoice({ storeId: store.id, orderId: params.id, actor: auth.user })
    return NextResponse.json({ id: invoice.id, number: invoice.number, version: invoice.version, total: Number(invoice.total), issuedAt: invoice.issuedAt }, { status: 201 })
  } catch (error) {
    if (error instanceof InvoiceError) return NextResponse.json({ error: error.code }, { status: STATUS[error.code] })
    throw error
  }
}
