import { NextResponse } from 'next/server'
import { getActiveStore } from '@/lib/store'
import { readBannerAsset } from '@/lib/content/assets'
export const runtime = 'nodejs'
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const store = await getActiveStore()
  const bytes = await readBannerAsset(store.id, params.id)
  if (!bytes) return new NextResponse(null, { status: 404 })
  return new NextResponse(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' } })
}
