import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { readImageBody, saveBannerAsset } from '@/lib/content/assets'

export const runtime = 'nodejs'

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'content')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const product = await prisma.product.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true } })
  if (!product) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  try {
    const url = await saveBannerAsset(store.id, await readImageBody(request))
    return NextResponse.json({ url }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && ['image_too_large', 'invalid_image'].includes(error.message)) {
      return NextResponse.json({ error: error.message }, { status: error.message === 'image_too_large' ? 413 : 400 })
    }
    throw error
  }
}
