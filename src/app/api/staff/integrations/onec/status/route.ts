import { NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/authz'
import { readStatus } from '@/lib/integrations/onec/status'
import { getActiveStore } from '@/lib/store'
import { resolveActiveSource } from '@/lib/integrations/sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Backoffice view of the last 1C exchange: steps, files, product/price/stock counts. */
export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const source = await resolveActiveSource(store.id, 'ONE_C')
  return NextResponse.json({ ...(source ? await readStatus(source.id) : {}), hasConnection: Boolean(source), connectionId: source?.id ?? null })
}
