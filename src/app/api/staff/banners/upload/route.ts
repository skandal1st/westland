import { NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { readImageBody, saveBannerAsset } from '@/lib/content/assets'
export const runtime = 'nodejs'
export async function POST(request: Request) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'content')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  try { return NextResponse.json({ url: await saveBannerAsset(store.id, await readImageBody(request)) }, { status: 201 }) }
  catch (error) {
    if (error instanceof Error && ['image_too_large', 'invalid_image'].includes(error.message)) return NextResponse.json({ error: error.message }, { status: error.message === 'image_too_large' ? 413 : 400 })
    throw error
  }
}
