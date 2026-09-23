import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { resolveActiveSource } from '@/lib/integrations/sources'
import { readCategoryGroups, setCategoryGroups } from '@/lib/integrations/category-management'
export const dynamic = 'force-dynamic'
export async function GET() {
  const auth = await requireApiUser(['STAFF','ADMIN']); if ('response' in auth) return auth.response
  const store = await getActiveStore(), source = await resolveActiveSource(store.id, 'ONE_C')
  return NextResponse.json({ hasConnection: !!source, groups: source ? await readCategoryGroups(source.id) : [] })
}
const schema = z.object({ externalIds: z.array(z.string().min(1)).min(1).max(2000), categoryId: z.string().min(1).nullable() }).strict()
export async function POST(request: Request) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core'); if ('response' in auth) return auth.response
  const parsed = schema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  const store = await getActiveStore(), source = await resolveActiveSource(store.id, 'ONE_C')
  if (!source) return NextResponse.json({ error: 'no_source' }, { status: 409 })
  try { return NextResponse.json(await setCategoryGroups(store.id, source.id, parsed.data.externalIds, parsed.data.categoryId, auth.user.id)) }
  catch (e) { if (e instanceof Error && ['source_changed','invalid_category','group_not_found','category_cycle'].includes(e.message)) return NextResponse.json({ error: e.message }, { status: 409 }); throw e }
}
