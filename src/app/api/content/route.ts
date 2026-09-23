import { NextResponse } from 'next/server'
import type { BannerPlacement } from '@prisma/client'
import { getCurrentUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { getActiveBanners, getContentBlocks } from '@/lib/content/read'
import { loadStoreProfile } from '@/lib/store-profile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Storefront content read endpoint (active banners + content blocks for a
 * placement). Honours the same closed-catalog policy as /api/catalog so managed
 * content is not exposed on a closed store to anonymous visitors.
 */
export async function GET(request: Request) {
  const profile = loadStoreProfile()
  if (!profile.modules.content) return NextResponse.json({ banners: [], blocks: [] })

  const user = await getCurrentUser()
  if (profile.policies.catalogRequiresAuth && !user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const placement = (url.searchParams.get('placement') ?? 'CATALOG').toUpperCase()
  if (placement !== 'HOME' && placement !== 'CATALOG') return NextResponse.json({ error: 'invalid_placement' }, { status: 400 })

  const store = await getActiveStore()
  const [banners, blocks] = await Promise.all([
    getActiveBanners({ storeId: store.id, placement: placement as BannerPlacement, categorySlug: url.searchParams.get('category'), brandSlug: url.searchParams.get('brand') }),
    getContentBlocks({ storeId: store.id, placement }),
  ])
  return NextResponse.json({ banners, blocks })
}
