import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { IntegrationInputError } from '@/lib/integrations/errors'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { retryOrderExport } from '@/lib/integrations/order-export'
import { AuditAction, recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const order = await prisma.order.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true, export: { select: { id: true } } } })
  if (!order || !order.export) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  try {
    const existing = await retryOrderExport(order.id)
    if (existing?.status === 'SUCCESS' || existing?.externalId) return NextResponse.json({ export: { orderId: order.id, status: 'SUCCESS', externalId: existing.externalId }, idempotent: true })
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof IntegrationInputError) return NextResponse.json({ error: error.code }, { status: error.status })
    throw error
  }
  await recordAudit(prisma, { storeId: store.id, actor: auth.user, action: AuditAction.OrderExportRetried, targetType: 'Order', targetId: order.id, summary: 'Order export retried' })
  return NextResponse.json({ orderId: order.id, exportId: order.export.id, status: 'PENDING', queued: true }, { status: 202 })
}
