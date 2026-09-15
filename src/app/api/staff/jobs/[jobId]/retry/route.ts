import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { retryJob, runDueJobs } from '@/lib/integrations/jobs'
import { AuditAction, recordAudit } from '@/lib/audit'
import { ProviderNotConfiguredError } from '@/lib/integrations/provider'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Manual retry of a failed integration job from backoffice. Recorded to audit
 * (IntegrationRetried). Idempotent: retrying an already-succeeded job is a
 * no-op and returns its current status without re-running it.
 */
export async function POST(_request: Request, { params }: { params: { jobId: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const existing = await prisma.integrationJob.findFirst({ where: { id: params.jobId, storeId: store.id }, select: { id: true, status: true } })
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  if (existing.status === 'SUCCEEDED') {
    return NextResponse.json({ jobId: existing.id, status: 'succeeded', idempotent: true })
  }

  const job = await retryJob(existing.id)
  await recordAudit(prisma, {
    storeId: store.id, actor: auth.user, action: AuditAction.IntegrationRetried,
    targetType: 'IntegrationJob', targetId: existing.id, summary: `Integration job ${job?.type ?? ''} retried`,
  })

  try {
    const results = await runDueJobs({ limit: 5 })
    return NextResponse.json({ result: results.find((r) => r.jobId === existing.id) ?? null })
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: 'provider_not_configured', provider: error.provider }, { status: 409 })
    }
    throw error
  }
}
