import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/authz'
import { loadStoreProfile } from '@/lib/store-profile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Catalog read endpoint (enforcement seam; real data lands in M3).
 *
 * The closed-catalog invariant is enforced HERE on the backend, not only by UI
 * redirects: when the profile requires auth, an unauthenticated request gets
 * 401 regardless of the frontend. A SUSPENDED user cannot hold a session, so
 * reaching this point already implies an ACTIVE user.
 */
export async function GET() {
  const profile = loadStoreProfile()
  if (profile.policies.catalogRequiresAuth) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ items: [] })
}
