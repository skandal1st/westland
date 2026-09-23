import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { retryJob } from '@/lib/integrations/jobs'
import { AuditAction, recordAudit } from '@/lib/audit'
import { IntegrationInputError as ExchangeError } from '@/lib/integrations/errors'
import { SourceProfileError } from '@/lib/integrations/sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Manual retry of a failed integration job from backoffice. Recorded to audit
 * (IntegrationRetried). Idempotent: retrying an already-succeeded job is a
 * no-op and returns its current status without re-running it.
 */
export async function POST(_request: Request, { params }: { params: { jobId: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const existing = await prisma.integrationJob.findFirst({ where: { id: params.jobId, storeId: store.id }, select: { id: true, status: true } })
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  if (existing.status === 'SUCCEEDED') {
    return NextResponse.json({ jobId: existing.id, status: 'succeeded', idempotent: true })
  }

  let job
  try {
    job = await retryJob(existing.id)
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof ExchangeError) return NextResponse.json({ error: error.code }, { status: error.status })
    if (error instanceof SourceProfileError) return NextResponse.json({ error: error.code }, { status: 409 })
    throw error
  }
  await recordAudit(prisma, {
    storeId: store.id, actor: auth.user, action: AuditAction.IntegrationRetried,
    targetType: 'IntegrationJob', targetId: existing.id, summary: `Integration job ${job?.type ?? ''} retried`,
  })

  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ jobId: job.id, status: job.status.toLowerCase(), queued: job.status !== 'SUCCEEDED' }, { status: job.status === 'SUCCEEDED' ? 200 : 202 })
}
