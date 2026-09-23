import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/authz'
import { getCartView, CartError } from '@/lib/cart/cart'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  try { return NextResponse.json(await getCartView(user)) } catch (error) {
    if (error instanceof CartError) return NextResponse.json({ error: error.code }, { status: 409 })
    throw error
  }
}
