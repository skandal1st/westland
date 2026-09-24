import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { HOME_COMPANY_BLOCK_KEY, homeCompanyBlockSchema } from '@/lib/content/home'
import { invalidateContentCache } from '@/lib/content/read'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const block = await prisma.contentBlock.findUnique({ where: { storeId_key: { storeId: store.id, key: HOME_COMPANY_BLOCK_KEY } } })
  return NextResponse.json({ block })
}

export async function PUT(request: Request) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'content')
  if ('response' in auth) return auth.response
  const parsed = homeCompanyBlockSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })
  const store = await getActiveStore()
  const { title, text, ctaLabel, ctaHref, isActive } = parsed.data
  const body = { text, ctaLabel, ctaHref }
  await prisma.contentBlock.upsert({
    where: { storeId_key: { storeId: store.id, key: HOME_COMPANY_BLOCK_KEY } },
    create: { storeId: store.id, key: HOME_COMPANY_BLOCK_KEY, placement: 'HOME', title, body, isActive, sortOrder: 100 },
    update: { placement: 'HOME', title, body, isActive },
  })
  invalidateContentCache(store.id)
  return NextResponse.json({ ok: true })
}
