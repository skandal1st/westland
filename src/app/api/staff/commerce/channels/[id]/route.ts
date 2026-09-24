import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { FulfillmentChannelUpdateError, updateFulfillmentChannel } from '@/lib/pricing/setup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({
  code: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  paymentMethod: z.enum(['BANK_TRANSFER', 'CASH']),
  inventoryLocationId: z.string().min(1),
  priceBookId: z.string().min(1).nullable(),
  isActive: z.boolean(),
}).strict()

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 })

  try {
    const channel = await updateFulfillmentChannel({
      storeId: auth.user.storeId,
      channelId: params.id,
      ...parsed.data,
      actor: auth.user,
    })
    return NextResponse.json({ channel }, { headers: { 'cache-control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof FulfillmentChannelUpdateError) {
      const status = error.code === 'CODE_EXISTS' ? 409 : error.code === 'NOT_FOUND' ? 404 : 400
      return NextResponse.json({ error: error.code }, { status })
    }
    throw error
  }
}
