import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/authz'
import { submitOrder, OrderError } from '@/lib/orders/orders'
import { runDueOrderExports } from '@/lib/integrations/order-export'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Submit a DRAFT order (owner). Business transition commits immediately; the
 * durable export is then processed in-process (no broker). The order stays
 * SUBMITTED regardless of export outcome.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const order = await submitOrder(user, params.id)
    const results = await runDueOrderExports({ limit: 5 })
    const mine = results.find((r) => r.orderId === order.id)
    return NextResponse.json({ orderId: order.id, number: order.number, status: order.status, export: mine ?? null })
  } catch (error) {
    if (error instanceof OrderError) return NextResponse.json({ error: error.code }, { status: error.code === 'NOT_FOUND' ? 404 : 409 })
    throw error
  }
}
