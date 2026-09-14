import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { enqueueJob, runDueJobs, JOB_CATALOG_IMPORT, JOB_PRICES_IMPORT, JOB_AVAILABILITY_IMPORT } from '@/lib/integrations/jobs'
import { ProviderNotConfiguredError } from '@/lib/integrations/provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Order matters: prices/availability resolve products by externalId, so the
// catalog must be imported first.
const SEQUENCE = [JOB_CATALOG_IMPORT, JOB_PRICES_IMPORT, JOB_AVAILABILITY_IMPORT]

/**
 * Trigger a full sync (catalog -> prices -> availability). Each step is a
 * durable, idempotent job processed in-process (no broker).
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const connection = await prisma.integrationConnection.findFirst({ where: { id: params.id, storeId: store.id } })
  if (!connection) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  try {
    const results = []
    for (const type of SEQUENCE) {
      await enqueueJob({ storeId: store.id, connectionId: connection.id, type })
      results.push(...(await runDueJobs({ limit: 5 })))
    }
    return NextResponse.json({ results })
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: 'provider_not_configured', provider: error.provider }, { status: 409 })
    }
    throw error
  }
}
