import { Prisma, type PrismaClient, type IntegrationJob, type OrderExport, type SyncRun } from '@prisma/client'
import { prisma as db } from '@/lib/db'
import { IMPORT_STAGES, summarizeStages, type SyncReport } from './import-result'

export const retryDelay = (attempt: number) => Math.min(60_000, 1_000 * 2 ** Math.min(16, Math.max(0, attempt - 1)))

/** Bounded, concurrent-safe sweeper. A live business transaction holds the row
 * lock, so recovery skips it even if its wall-clock lease has just expired. */
export async function recoverExpiredWork(client: PrismaClient = db, limit = 100, storeId?: string) {
  const take = Math.max(1, Math.min(500, Math.floor(limit)))
  return client.$transaction(async tx => {
    const jobs = await tx.$queryRaw<IntegrationJob[]>`SELECT * FROM "IntegrationJob"
      WHERE (${storeId ?? null}::text IS NULL OR "storeId" = ${storeId ?? null}) AND ((status = 'RUNNING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp()))
        OR (status IN ('PENDING', 'RETRYING') AND attempts >= "maxAttempts"))
      ORDER BY "availableAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED`
    for (const job of jobs) {
      const terminal = job.attempts >= job.maxAttempts
      const reason = job.status === 'RUNNING' ? 'execution_lease_expired' : 'attempts_exhausted'
      await tx.integrationAttempt.updateMany({ where: { jobId: job.id, status: 'RUNNING' }, data: { status: 'FAILED', finishedAt: new Date(), error: reason } })
      await tx.$executeRaw`UPDATE "IntegrationJob" SET status = ${terminal ? 'FAILED' : 'RETRYING'}::"IntegrationJobStatus",
        "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastError" = ${reason}, "updatedAt" = clock_timestamp(),
        "finishedAt" = CASE WHEN ${terminal} THEN clock_timestamp() ELSE NULL END,
        "availableAt" = clock_timestamp() + ${retryDelay(job.attempts)} * interval '1 millisecond' WHERE id = ${job.id}`
      await tx.integrationError.create({ data: { storeId: job.storeId, connectionId: job.connectionId, jobId: job.id, code: 'JOB_LEASE_RECOVERED', message: reason } })
    }
    const exports = await tx.$queryRaw<OrderExport[]>`SELECT * FROM "OrderExport"
      WHERE (${storeId ?? null}::text IS NULL OR "storeId" = ${storeId ?? null}) AND ((status = 'PROCESSING' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp()))
        OR (status IN ('PENDING', 'RETRYING') AND attempts >= "maxAttempts"))
      ORDER BY "availableAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED`
    for (const record of exports) {
      // Legacy PROCESSING did not count the attempt until the remote call returned.
      const attempts = record.attempts + (record.status === 'PROCESSING' && !record.leaseToken ? 1 : 0)
      const status = record.externalId ? 'SUCCESS' : attempts >= record.maxAttempts ? 'FAILED' : 'RETRYING'
      await tx.$executeRaw`UPDATE "OrderExport" SET status = ${status}::"OrderExportStatus", attempts = ${attempts},
        "leaseToken" = NULL, "leaseExpiresAt" = NULL, "lastError" = 'execution_lease_expired', "updatedAt" = clock_timestamp(),
        "availableAt" = clock_timestamp() + ${retryDelay(attempts)} * interval '1 millisecond' WHERE id = ${record.id}`
      await tx.integrationError.create({ data: { storeId: record.storeId, connectionId: record.connectionId, code: 'EXPORT_LEASE_RECOVERED', message: 'execution_lease_expired', context: { orderId: record.orderId } } })
    }
    const runs = await tx.$queryRaw<SyncRun[]>`SELECT * FROM "SyncRun" WHERE queued = false AND "entityType" = 'commerce.sync' AND status = 'RUNNING'
      AND (${storeId ?? null}::text IS NULL OR EXISTS (SELECT 1 FROM "IntegrationConnection" c WHERE c.id = "SyncRun"."connectionId" AND c."storeId" = ${storeId ?? null}))
      AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp()) ORDER BY "createdAt", id LIMIT ${take} FOR UPDATE SKIP LOCKED`
    for (const run of runs) {
      const previous = run.stats as unknown as SyncReport | null
      const report: SyncReport = { runId: run.id, generationId: previous?.generationId ?? null, outcome: 'failed', error: 'execution_lease_expired',
        results: (Array.isArray(previous?.results) ? previous.results : IMPORT_STAGES.map(type => ({ type, status: 'pending' as const }))).map(stage =>
          stage.status === 'running' ? { ...stage, status: 'failed', outcome: 'failed', message: 'execution_lease_expired' } :
          stage.status === 'pending' ? { ...stage, status: 'skipped', outcome: 'skipped', message: 'previous_stage_incomplete' } : stage) }
      report.outcome = summarizeStages(report.results)
      if (report.outcome === 'success') delete report.error
      await tx.syncRun.update({ where: { id: run.id }, data: { status: report.outcome === 'success' ? 'SUCCEEDED' : report.outcome === 'partial' ? 'PARTIAL' : 'FAILED',
        stats: report as unknown as Prisma.InputJsonValue, error: report.error ?? null, finishedAt: new Date(), leaseToken: null, leaseExpiresAt: null } })
    }
    return { jobs: jobs.length, exports: exports.length, runs: runs.length }
  }, { timeout: 30_000 })
}
