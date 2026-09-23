import { CapabilityError } from '@/lib/capabilities'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/authz'
import { checkout, CheckoutError } from '@/lib/cart/checkout'
import { LicenseError } from '@/lib/license'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({ deliveryLocationId: z.string().min(1), comment: z.string().max(1000).optional(), idempotencyKey: z.string().min(8).max(100), cartId: z.string().min(1), cartVersion: z.number().int().min(0).max(2147483647) }).strict()

const STATUS: Record<CheckoutError['code'], number> = {
  GIFT_SELECTION_REQUIRED: 409, MIXED_CURRENCY: 409, INVALID_AMOUNT: 409,
  ITEM_UNAVAILABLE: 409, CART_CHANGED: 409, IDEMPOTENCY_CONFLICT: 409, EMPTY_CART: 400, NO_CHANNEL: 400, NO_CUSTOMER: 403, INVALID_DELIVERY: 400, NO_PRICE: 409,
}

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  try {
    const order = await checkout(user, parsed.data)
    return NextResponse.json({ orderId: order.id, number: order.number, status: order.status, total: order.total.toFixed(2), currency: order.currency }, { status: 201 })
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message, ...(error instanceof LicenseError ? { license: error.status } : {}) }, { status: 403 })

    if (error instanceof CheckoutError) return NextResponse.json({ error: error.code }, { status: STATUS[error.code] })
    throw error
  }
}
