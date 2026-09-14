import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { enqueueJob, runDueJobs, JOB_CATALOG_IMPORT } from '@/lib/integrations/jobs'
import { ProviderNotConfiguredError } from '@/lib/integrations/provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Trigger a catalog import. Enqueues a durable job and processes due jobs in
 * process (no broker). Idempotent: an active job for this connection is reused.
 */
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const connection = await prisma.integrationConnection.findFirst({ where: { id: params.id, storeId: store.id } })
  if (!connection) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  try {
    const job = await enqueueJob({ storeId: store.id, connectionId: connection.id, type: JOB_CATALOG_IMPORT })
    const results = await runDueJobs({ limit: 5 })
    return NextResponse.json({ jobId: job.id, results })
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: 'provider_not_configured', provider: error.provider }, { status: 409 })
    }
    throw error
  }
}
