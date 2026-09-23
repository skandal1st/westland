import type { IntegrationJob, PrismaClient } from '@prisma/client'
import { retryDelay } from './recovery'
import { storedAttemptResult, type RunResult } from './import-result'

export type JobFailure = {
  attemptId: string; attempt: number; terminal: boolean
  result: RunResult & { status: 'failed' | 'retrying'; outcome: 'failed' | 'partial'; message: string }
}

/** Diagnostic-only completion. Business writes always require a live lease.
 * Expiry alone may not discard the primary failure, but recovery/claim wins as
 * soon as it changes the token. Lock in the same order as claim and recovery.
 */
export async function persistJobFailure(client: PrismaClient, jobId: string, token: string, failure: JobFailure) {
  return client.$transaction(async tx => {
    const [job] = await tx.$queryRaw<IntegrationJob[]>`SELECT * FROM "IntegrationJob" WHERE id = ${jobId} FOR UPDATE`
    if (!job) return false
    const attempt = await tx.integrationAttempt.findFirst({ where: { id: failure.attemptId, jobId, attempt: failure.attempt } })
    if (!attempt || !['RUNNING', 'FAILED', 'PARTIAL'].includes(attempt.status)) return false
    const owned = job.status === 'RUNNING' && job.leaseToken === token && job.attempts === failure.attempt && attempt.status === 'RUNNING'
    // Idempotent per attempt, including a late diagnostic after recovery.
    const recorded = await tx.integrationError.createMany({ skipDuplicates: true, data: [{
      id: `job-failure:${attempt.id}`, storeId: job.storeId, connectionId: job.connectionId, jobId,
      code: 'JOB_FAILED', message: failure.result.message,
      context: { attemptId: attempt.id, attempt: attempt.attempt, superseded: !owned, failure: failure.result.failure ?? { message: failure.result.message } },
    }] })
    if (!recorded.count) return false
    if (owned) {
      const rows = await tx.integrationError.findMany({ where: { jobId, createdAt: { gte: attempt.startedAt }, OR: [{ code: { not: 'JOB_FAILED' } }, { context: { path: ['attemptId'], equals: attempt.id } }] }, orderBy: { createdAt: 'asc' }, take: 20, select: { code: true, message: true, context: true } })
      failure.result.issues = rows.map(row => ({ code: row.code, message: row.message, ...(row.context && typeof row.context === 'object' && 'externalId' in row.context && typeof row.context.externalId === 'string' ? { externalId: row.context.externalId } : {}) }))
      await tx.integrationJob.update({ where: { id: jobId }, data: {
        status: failure.result.status === 'retrying' ? 'RETRYING' : 'FAILED', leaseToken: null, leaseExpiresAt: null,
        lastError: failure.result.message, finishedAt: failure.terminal ? new Date() : null,
        ...(failure.terminal ? {} : { availableAt: new Date(Date.now() + retryDelay(attempt.attempt)) }),
      } })
      await tx.integrationAttempt.update({ where: { id: attempt.id }, data: {
        status: failure.result.outcome === 'partial' ? 'PARTIAL' : 'FAILED', error: failure.result.message,
        stats: failure.result as any, finishedAt: new Date(),
      } })
    } else {
      // Historical diagnostics only: never revise scheduling, a successor attempt,
      // or a frozen SyncRun. Preserve recovery's completion time and status.
      const previous = storedAttemptResult(attempt.stats, job)
      await tx.integrationAttempt.update({ where: { id: attempt.id }, data: {
        error: failure.result.message,
        stats: { ...(previous ?? { ...failure.result, status: 'failed' }), failure: failure.result.failure, message: failure.result.message } as any,
      } })
    }
    return owned
  })
}
