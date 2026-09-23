import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/authz'
import { submitOrder, OrderError } from '@/lib/orders/orders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const schema = z.object({ priceConfirmationToken: z.string().uuid().optional() }).strict()

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const text = await request.text()
  let body: unknown
  try { body = text ? JSON.parse(text) : {} } catch { return NextResponse.json({ error: 'invalid_input' }, { status: 400 }) }
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  try {
    const order = await submitOrder(user, params.id, undefined, parsed.data)
    return NextResponse.json({ orderId: order.id, number: order.number, status: order.status, total: order.total.toString(), currency: order.currency })
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof OrderError) return NextResponse.json({ error: error.code, ...(error.quote ? { quote: error.quote } : {}) }, { status: error.code === 'NOT_FOUND' ? 404 : 409 })
    throw error
  }
}
