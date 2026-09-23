import { CapabilityError } from '@/lib/capabilities'
import { NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/authz'
import { z } from 'zod'
import { LicenseError } from '@/lib/license'
import { issueInvoice, InvoiceError } from '@/lib/invoices/invoices'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS: Record<InvoiceError['code'], number> = {
  ORDER_NOT_FOUND: 404,
  NOT_FOUND: 404,
  INVALID_STATE: 409,
  NO_SELLER_REQUISITES: 409,
  NO_BANK_REQUISITES: 409,
  SNAPSHOT_REQUIRED: 409,
  INVALID_INPUT: 400,
  VERSION_CONFLICT: 409,
  REQUEST_CONFLICT: 409,
  NUMBER_CONFLICT: 409,
}

/**
 * Issue (or reissue) the invoice for an order. Staff/admin only. A reissue
 * creates a new immutable version and VOIDs the previous one — audited as
 * InvoiceIssued / InvoiceReissued.
 */
const schema = z.object({ requestKey: z.string().uuid(), expectedVersion: z.number().int().min(0).max(2147483646) }).strict()

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'invoices')
  if ('response' in auth) return auth.response
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 })

  try {
    const invoice = await issueInvoice({ storeId: auth.user.storeId, orderId: params.id, actor: auth.user, ...parsed.data })
    return NextResponse.json({ id: invoice.id, number: invoice.number, version: invoice.version, status: invoice.status, repeated: invoice.repeated, total: invoice.total.toFixed(2), issuedAt: invoice.issuedAt }, { status: invoice.repeated ? 200 : 201 })
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })

    if (error instanceof InvoiceError) return NextResponse.json({ error: error.code }, { status: STATUS[error.code] })
    throw error
  }
}
