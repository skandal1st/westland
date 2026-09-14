import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/authz'
import { getCartView } from '@/lib/cart/cart'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json(await getCartView(user))
}
