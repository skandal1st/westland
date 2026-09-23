import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { invalidateContentCache } from '@/lib/content/read'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const blockSchema = z.object({
  key: z.string().min(1).regex(/^[a-z0-9-]+$/),
  placement: z.string().min(1).default('HOME'),
  title: z.string().nullish(),
  body: z.unknown().optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
})

export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const blocks = await prisma.contentBlock.findMany({
    where: { storeId: store.id },
    orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }],
    select: { id: true, key: true, placement: true, title: true, body: true, isActive: true, sortOrder: true },
  })
  return NextResponse.json({ blocks })
}

export async function POST(request: Request) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'content')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const parsed = blockSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  const { body, ...rest } = parsed.data
  try {
    const block = await prisma.contentBlock.create({ data: { storeId: store.id, ...rest, body: (body ?? undefined) as any } })
    invalidateContentCache(store.id)
    return NextResponse.json({ id: block.id }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'conflict' }, { status: 409 })
  }
}
