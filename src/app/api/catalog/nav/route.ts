import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { listCatalogNav } from '@/lib/catalog/read'
import { loadStoreProfile } from '@/lib/store-profile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Storefront navigation (mega-menu): real categories and brands for the active
 * store. Honours the closed-catalog policy — anonymous visitors get an empty nav
 * rather than a 401, so the header degrades gracefully on the public landing.
 */
export async function GET() {
  const requiresAuth = loadStoreProfile().policies.catalogRequiresAuth
  const user = await getCurrentUser()
  if (requiresAuth && !user) return NextResponse.json({ categories: [], brands: [] })

  const store = await getActiveStore()
  const nav = await listCatalogNav(store.id)
  return NextResponse.json(nav)
}
