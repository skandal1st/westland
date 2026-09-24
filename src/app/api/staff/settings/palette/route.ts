import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { recordAudit } from '@/lib/audit'
import { PaletteSchema } from '@/lib/palette'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = PaletteSchema.transform(palette => ({ palette }))

export async function PUT(request: Request) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response

  const parsed = schema.safeParse((await request.json().catch(() => null))?.palette)
  if (!parsed.success) return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 })

  await prisma.$transaction(async tx => {
    await tx.appSettings.upsert({
      where: { storeId: auth.user.storeId },
      update: parsed.data,
      create: { storeId: auth.user.storeId, ...parsed.data },
    })
    await recordAudit(tx, {
      storeId: auth.user.storeId,
      actor: auth.user,
      action: 'StorePaletteChanged',
      targetType: 'AppSettings',
      targetId: auth.user.storeId,
      summary: `Store palette changed to ${parsed.data.palette}`,
      metadata: parsed.data,
    })
  })

  return NextResponse.json(parsed.data, { headers: { 'cache-control': 'private, no-store' } })
}
