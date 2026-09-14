import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { transitionOrder, OrderError } from '@/lib/orders/orders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({ to: z.enum(['SUBMITTED', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'CANCELLED']) })

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })

  try {
    const order = await transitionOrder({ storeId: store.id, orderId: params.id, to: parsed.data.to, actor: auth.user })
    return NextResponse.json({ status: order.status })
  } catch (error) {
    if (error instanceof OrderError) return NextResponse.json({ error: error.code }, { status: error.code === 'NOT_FOUND' ? 404 : 409 })
    throw error
  }
}
