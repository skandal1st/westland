import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { retryOrderExport, runDueOrderExports } from '@/lib/integrations/order-export'
import { AuditAction, recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const order = await prisma.order.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true, export: { select: { id: true } } } })
  if (!order || !order.export) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  await retryOrderExport(order.id)
  await recordAudit(prisma, { storeId: store.id, actor: auth.user, action: AuditAction.OrderExportRetried, targetType: 'Order', targetId: order.id, summary: 'Order export retried' })
  const results = await runDueOrderExports({ limit: 5 })
  return NextResponse.json({ export: results.find((r) => r.orderId === order.id) ?? null })
}
