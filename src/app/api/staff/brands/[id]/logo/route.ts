import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { readImageBody, saveBannerAsset } from '@/lib/content/assets'
import { invalidateContentCache } from '@/lib/content/read'

export const runtime = 'nodejs'

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'content')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const brand = await prisma.brand.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true } })
  if (!brand) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  try {
    const logoUrl = await saveBannerAsset(store.id, await readImageBody(request))
    await prisma.brand.update({ where: { id: brand.id }, data: { logoUrl } })
    invalidateContentCache(store.id)
    return NextResponse.json({ logoUrl }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && ['image_too_large', 'invalid_image'].includes(error.message)) return NextResponse.json({ error: error.message }, { status: error.message === 'image_too_large' ? 413 : 400 })
    throw error
  }
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'content')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const result = await prisma.brand.updateMany({ where: { id: params.id, storeId: store.id }, data: { logoUrl: null } })
  if (!result.count) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  invalidateContentCache(store.id)
  return NextResponse.json({ ok: true })
}
