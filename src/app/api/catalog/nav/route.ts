import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { listCatalogNav } from '@/lib/catalog/read'
import { loadStoreProfile } from '@/lib/store-profile'
import { prisma } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Storefront navigation (mega-menu): real categories and brands for the active
 * store. Honours the closed-catalog policy — anonymous visitors get an empty nav
 * rather than a 401, so the header degrades gracefully on the public landing.
 */
export async function GET(request: Request) {
  const requiresAuth = loadStoreProfile().policies.catalogRequiresAuth
  const user = await getCurrentUser()
  if (requiresAuth && !user) return NextResponse.json({ categories: [], brands: [] })

  const requestedChannelId = new URL(request.url).searchParams.get('channel')
  if (requestedChannelId && requestedChannelId.length > 100) return NextResponse.json({ error: 'invalid_channel' }, { status: 400 })
  const store = await getActiveStore()
  const settings = await prisma.appSettings.findUnique({ where: { storeId: store.id }, select: { showOutOfStock: true } })
  let channelId: string | null = null
  if (settings?.showOutOfStock === false) {
    const cart = !requestedChannelId && user
      ? await prisma.cart.findUnique({ where: { userId: user.id }, select: { fulfillmentChannelId: true } })
      : null
    const preferredId = requestedChannelId ?? cart?.fulfillmentChannelId
    const preferred = preferredId
      ? await prisma.fulfillmentChannel.findFirst({ where: { id: preferredId, storeId: store.id, isActive: true }, select: { id: true } })
      : null
    channelId = preferred?.id ?? (await prisma.fulfillmentChannel.findFirst({ where: { storeId: store.id, isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true } }))?.id ?? null
  }
  const nav = await listCatalogNav({ storeId: store.id, channelId, hideOutOfStock: settings?.showOutOfStock === false })
  return NextResponse.json(nav)
}
