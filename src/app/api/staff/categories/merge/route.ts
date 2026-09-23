import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { mergeCategories } from '@/lib/catalog/merge-categories'
export const runtime = 'nodejs'
const schema = z.object({ targetId: z.string().min(1), sourceIds: z.array(z.string().min(1)).min(1).max(500) })
export async function POST(request: Request) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_selection' }, { status: 400 })
  const store = await getActiveStore()
  try { return NextResponse.json(await mergeCategories(store.id, parsed.data.targetId, parsed.data.sourceIds, auth.user.id)) }
  catch (error) {
    if (error instanceof Error && ['invalid_selection', 'category_not_found'].includes(error.message)) return NextResponse.json({ error: error.message }, { status: 400 })
    throw error
  }
}
