import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/authz'
import { cancelOrder, OrderError } from '@/lib/orders/orders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try {
    const { order, requested } = await cancelOrder(user, params.id)
    return NextResponse.json({ orderId: order.id, status: order.status, requested, cancellationRequestedAt: order.cancellationRequestedAt })
  } catch (error) {
    if (error instanceof OrderError) return NextResponse.json({ error: error.code }, { status: error.code === 'NOT_FOUND' ? 404 : 409 })
    throw error
  }
}
