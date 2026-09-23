import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { listCatalog } from '@/lib/catalog/read'
import { resolveBuyerPriceGroupId } from '@/lib/pricing'
import { loadStoreProfile } from '@/lib/store-profile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Catalog listing assembled from canonical identity + commerce overlay and
 * enriched with contextual price (buyer group) and availability (selected
 * channel). Closed-catalog is enforced here on the backend.
 */
export async function GET(request: Request) {
  const requiresAuth = loadStoreProfile().policies.catalogRequiresAuth
  const user = await getCurrentUser()
  if (requiresAuth && !user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const take = Number(url.searchParams.get('take') ?? '50')
  const skip = Number(url.searchParams.get('skip') ?? '0')
  const query = (url.searchParams.get('q') ?? '').trim()
  if (!Number.isSafeInteger(take) || take < 1 || take > 100 || !Number.isSafeInteger(skip) || skip < 0 || skip > 2147483647 || query.length > 200) {
    return NextResponse.json({ error: 'invalid_catalog_query' }, { status: 400 })
  }
  const channelId = url.searchParams.get('channel') || undefined
  const categorySlug = url.searchParams.get('category') || undefined
  const brandSlug = url.searchParams.get('brand') || undefined
  const store = await getActiveStore()
  const groupId = user ? await resolveBuyerPriceGroupId(user) : null

  const { items, total } = await listCatalog({ storeId: store.id, take, skip, query, groupId, channelId, categorySlug, brandSlug })
  return NextResponse.json({ items, total })
}
