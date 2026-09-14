import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/authz'
import { setCartChannel, CartError, getCartView } from '@/lib/cart/cart'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({ channelId: z.string().min(1) })

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  try {
    await setCartChannel(user, parsed.data.channelId)
    return NextResponse.json(await getCartView(user))
  } catch (error) {
    if (error instanceof CartError) return NextResponse.json({ error: error.code }, { status: 400 })
    throw error
  }
}
