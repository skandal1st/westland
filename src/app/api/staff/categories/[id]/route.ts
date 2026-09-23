import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  hidden: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
})

/** Rename / hide / reorder a category (ADMIN). Slug stays stable so links survive. */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  const category = await prisma.category.findFirst({ where: { id: params.id, storeId: store.id, mergedIntoId: null } })
  if (!category) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const updated = await prisma.category.update({ where: { id: category.id }, data: parsed.data })
  return NextResponse.json({ id: updated.id, name: updated.name, hidden: updated.hidden, sortOrder: updated.sortOrder })
}
