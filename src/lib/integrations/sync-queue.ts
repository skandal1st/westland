import { assertCapability } from '@/lib/capabilities'
import { randomUUID } from 'node:crypto'
import { Prisma, type IntegrationConnection, type PrismaClient, type SyncRun } from '@prisma/client'
import { prisma as db } from '@/lib/db'
import { requireActiveSource } from './sources'
import { requireSourceGeneration } from './generations'
import { IntegrationInputError } from './errors'
import { IMPORT_STAGES, storedAttemptResult, summarizeStages, type StageResult, type SyncReport } from './import-result'

/** Persist the whole dependency chain before returning HTTP 202. No provider IO. */
export async function enqueueSourceSync(connection: IntegrationConnection, generationId?: string, client: PrismaClient = db): Promise<SyncReport> {
  assertCapability('commerce-core')

  const source = await requireActiveSource(connection.id, connection.storeId, client)
  if (source.provider === 'ONE_C') {
    if (!generationId) throw new IntegrationInputError('generation_required')
    await requireSourceGeneration(source.id, generationId, client)
  } else generationId = undefined
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sync:${source.id}`}, 0))::text`
    const active = await tx.syncRun.findFirst({ where: { connectionId: source.id, queued: true, status: { in: ['PENDING', 'RUNNING'] } }, orderBy: { createdAt: 'asc' } })
    if (active) {
      const report = active.stats as unknown as SyncReport
      if (report.generationId !== (generationId ?? null)) throw new IntegrationInputError('source_sync_busy')
      return report
    }
    // Serialize against standalone enqueue/retry for each of these same streams.
    for (const type of IMPORT_STAGES) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${source.id}:${type}`}, 0))::text`
    const busy = await tx.integrationJob.count({ where: { connectionId: source.id, type: { in: [...IMPORT_STAGES] }, status: { in: ['PENDING', 'RUNNING', 'RETRYING'] } } })
    if (busy) throw new IntegrationInputError('source_sync_busy')
    const run = await tx.syncRun.create({ data: { connectionId: source.id, entityType: 'commerce.sync', queued: true } })
    const report: SyncReport = { runId: run.id, generationId: generationId ?? null, outcome: 'pending', results: [] }
    let dependsOnId: string | undefined
    for (const type of IMPORT_STAGES) {
      const job = await tx.integrationJob.create({ data: { storeId: source.storeId, connectionId: source.id, generationId, type,
        syncRunId: run.id, dependsOnId, idempotencyKey: `${run.id}:${type}:${randomUUID()}` } })
      report.results.push({ jobId: job.id, type, status: 'pending' })
      dependsOnId = job.id
    }
    await tx.syncRun.update({ where: { id: run.id }, data: { stats: report as unknown as Prisma.InputJsonValue } })
    return report
  })
}

/** Reconstruct progress from durable jobs. Safe after any worker crash, including
 * between finishing one job and projecting its report. Terminal reports stay historical. */
export async function refreshQueuedSyncRuns(client: PrismaClient = db, storeId?: string) {
  return client.$transaction(async tx => {
    const runs = await tx.$queryRaw<Array<SyncRun & { sourceEnabled: boolean; sourceState: string }>>`SELECT r.*, c.enabled AS "sourceEnabled", c."sourceState" FROM "SyncRun" r JOIN "IntegrationConnection" c ON c.id = r."connectionId"
      WHERE r.queued = true AND r.status IN ('PENDING', 'RUNNING') AND (${storeId ?? null}::text IS NULL OR c."storeId" = ${storeId ?? null})
      ORDER BY r."createdAt" LIMIT 100 FOR UPDATE OF r SKIP LOCKED`
    for (const run of runs) {
      const jobs = await tx.integrationJob.findMany({ where: { syncRunId: run.id }, include: { attemptsLog: { orderBy: { attempt: 'desc' }, take: 1 } } })
      const previous = run.stats as unknown as SyncReport
      const stages: StageResult[] = []
      let blocked = false
      for (const type of IMPORT_STAGES) {
        const job = jobs.find(j => j.type === type)
        if (!job) throw new IntegrationInputError('sync_chain_incomplete')
        if (!blocked && (!run.sourceEnabled || run.sourceState !== 'ACTIVE') && ['PENDING', 'RETRYING'].includes(job.status)) {
          const changed = await tx.integrationJob.updateMany({ where: { id: job.id, status: { in: ['PENDING', 'RETRYING'] } }, data: { status: 'FAILED', lastError: 'source_not_active', finishedAt: new Date() } })
          if (changed.count) { job.status = 'FAILED'; job.lastError = 'source_not_active' }
        }
        if (blocked && job.status === 'PENDING') {
          const changed = await tx.integrationJob.updateMany({ where: { id: job.id, status: 'PENDING' }, data: { status: 'SKIPPED', lastError: 'previous_stage_incomplete', finishedAt: new Date() } })
          if (changed.count) { job.status = 'SKIPPED'; job.lastError = 'previous_stage_incomplete' }
        }
        const result = storedAttemptResult(job.attemptsLog[0]?.stats, job)
        const stage: StageResult = { ...(result ?? {}), jobId: job.id, type, status: job.status.toLowerCase() as StageResult['status'] }
        if (job.status === 'PENDING' || job.status === 'RUNNING') delete stage.outcome
        else if (job.status === 'SUCCEEDED') stage.outcome = 'success'
        else if (job.status === 'SKIPPED') stage.outcome = 'skipped'
        else if (job.status === 'PARTIAL') stage.outcome = 'partial'
        else stage.outcome = result?.outcome === 'partial' ? 'partial' : 'failed'
        if (job.lastError) stage.message = job.lastError
        stages.push(stage)
        if (['FAILED', 'PARTIAL', 'SKIPPED'].includes(job.status)) blocked = true
      }
      const active = jobs.some(j => ['PENDING', 'RUNNING', 'RETRYING'].includes(j.status))
      const started = jobs.some(j => j.attempts > 0)
      const report: SyncReport = { runId: run.id, generationId: previous.generationId, results: stages,
        outcome: active ? started ? 'running' : 'pending' : summarizeStages(stages) }
      if (!active) report.error = stages.find(s => s.outcome !== 'success')?.message
      await tx.syncRun.update({ where: { id: run.id }, data: { stats: report as unknown as Prisma.InputJsonValue,
        status: active ? started ? 'RUNNING' : 'PENDING' : report.outcome === 'success' ? 'SUCCEEDED' : report.outcome === 'partial' ? 'PARTIAL' : 'FAILED',
        startedAt: started ? run.startedAt ?? new Date() : null, finishedAt: active ? null : new Date(), error: report.error ?? null } })
    }
    return runs.length
  }, { timeout: 30_000 })
}
