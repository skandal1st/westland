import { getCurrentUser, isStaff } from '@/lib/authz'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getCurrentInvoice } from '@/lib/invoices/invoices'
import { getInvoicePdf } from '@/lib/invoices/pdf-service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Download the current invoice PDF for an order. The buyer who owns the order or
 * any staff member may fetch it; the PDF is always behind authorization. The
 * bytes are served from the media cache or regenerated from the immutable
 * snapshot on a miss.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const order = await prisma.order.findFirst({ where: { id: params.id, storeId: user.storeId }, select: { userId: true } })
  if (!order) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (order.userId !== user.id && !isStaff(user.role)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const invoice = await getCurrentInvoice({ storeId: user.storeId, orderId: params.id })
  if (!invoice) return NextResponse.json({ error: 'not_issued' }, { status: 404 })

  const pdf = await getInvoicePdf(invoice)
  return new NextResponse(pdf as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="invoice-${invoice.number}.pdf"`,
      'cache-control': 'private, no-store',
    },
  })
}
