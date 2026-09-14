import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { listCatalog } from '@/lib/catalog/read'
import { loadStoreProfile } from '@/lib/store-profile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Catalog listing assembled from canonical identity + commerce overlay.
 *
 * The closed-catalog invariant is enforced HERE on the backend: when the
 * profile requires auth, an unauthenticated request gets 401 regardless of the
 * frontend. Items are empty until the operational provider imports a catalog
 * (M4); the assembly path is what M3 delivers.
 */
export async function GET(request: Request) {
  if (loadStoreProfile().policies.catalogRequiresAuth) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const url = new URL(request.url)
  const take = Number(url.searchParams.get('take') ?? '50')
  const skip = Number(url.searchParams.get('skip') ?? '0')
  const store = await getActiveStore()
  const { items, total } = await listCatalog({ storeId: store.id, take, skip })
  return NextResponse.json({ items, total })
}
