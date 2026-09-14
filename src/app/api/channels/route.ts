import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { listActiveChannels } from '@/lib/pricing/setup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Active fulfillment channels for the storefront selector (auth required). */
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const store = await getActiveStore()
  const channels = await listActiveChannels(store.id)
  return NextResponse.json({ channels })
}
