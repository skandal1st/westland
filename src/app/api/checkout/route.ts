import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/authz'
import { checkout, CheckoutError } from '@/lib/cart/checkout'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({ deliveryLocationId: z.string().min(1), comment: z.string().max(1000).optional(), idempotencyKey: z.string().min(8).max(100).optional() })

const STATUS: Record<CheckoutError['code'], number> = {
  EMPTY_CART: 400, NO_CHANNEL: 400, NO_CUSTOMER: 403, INVALID_DELIVERY: 400, NO_PRICE: 409, INSUFFICIENT_STOCK: 409,
}

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  try {
    const order = await checkout(user, parsed.data)
    return NextResponse.json({ orderId: order.id, number: order.number, status: order.status, total: Number(order.total), currency: order.currency }, { status: 201 })
  } catch (error) {
    if (error instanceof CheckoutError) return NextResponse.json({ error: error.code }, { status: STATUS[error.code] })
    throw error
  }
}
