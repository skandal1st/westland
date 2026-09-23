import { assertCapability } from '@/lib/capabilities'
import { classifyImport, importFailure, ImportExecutionError, type ImportCounters, type ImportIssue, type RunResult } from './import-result'
export type { RunResult } from './import-result'
import crypto from 'node:crypto'
import { executionLease, LEASE_MS } from './lease'
import { recoverExpiredWork, retryDelay } from './recovery'
import { refreshQueuedSyncRuns } from './sync-queue'
import type { IntegrationConnection, IntegrationJob, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { importCatalog } from '@/lib/integrations/import-catalog'
import { importPrices } from '@/lib/integrations/import-prices'
import { importAvailability } from '@/lib/integrations/import-availability'
import { getProvider } from '@/lib/integrations/registry'
import type { OperationalProvider } from '@/lib/integrations/provider'
import { latestGeneration, requireGeneration } from '@/lib/integrations/onec/ledger'
import { ExchangeError } from '@/lib/integrations/onec/storage'
import { requireActiveSource } from '@/lib/integrations/sources'

export const JOB_CATALOG_IMPORT = 'catalog.import'
export const JOB_PRICES_IMPORT = 'prices.import'
export const JOB_AVAILABILITY_IMPORT = 'availability.import'

type HandlerDeps = { prisma: PrismaClient; job: IntegrationJob; provider: OperationalProvider }
type Handler = (deps: HandlerDeps) => Promise<ImportCounters>

const handlers: Record<string, Handler> = {
  [JOB_CATALOG_IMPORT]: async ({ prisma, job, provider }) => {
    return importCatalog({ storeId: job.storeId, connectionId: job.connectionId, jobId: job.id, generationId: job.generationId ?? undefined, provider }, prisma) as Promise<ImportCounters>
  },
  [JOB_PRICES_IMPORT]: async ({ prisma, job, provider }) => {
    return importPrices({ storeId: job.storeId, connectionId: job.connectionId, jobId: job.id, provider }, prisma) as Promise<ImportCounters>
  },
  [JOB_AVAILABILITY_IMPORT]: async ({ prisma, job, provider }) => {
    return importAvailability({ storeId: job.storeId, connectionId: job.connectionId, jobId: job.id, provider }, prisma) as Promise<ImportCounters>
  },
}

/** Idempotent enqueue: an active job for (connection, type) is reused, not duplicated. */
export async function enqueueJob(
  input: { storeId: string; connectionId: string; type: string; generationId?: string; payload?: unknown; maxAttempts?: number },
  client: PrismaClient = defaultPrisma,
): Promise<IntegrationJob> {
  assertCapability('commerce-core')

  const source = await requireActiveSource(input.connectionId, input.storeId, client)
  const generationId = source.provider === 'ONE_C' ? input.generationId ?? (await latestGeneration(source.id, client))?.id : undefined
  if (source.provider === 'ONE_C') {
    if (!generationId) throw new ExchangeError('generation_required')
    await requireGeneration(source.id, generationId, client)
  }
  if (!Number.isInteger(input.maxAttempts ?? 5) || (input.maxAttempts ?? 5) < 1 || (input.maxAttempts ?? 5) > 100) throw new ExchangeError('invalid_max_attempts')
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.connectionId}:${input.type}`}, 0))::text`
    const active = await tx.integrationJob.findFirst({
      where: { connectionId: input.connectionId, type: input.type, generationId: generationId ?? null, status: { in: ['PENDING', 'RUNNING', 'RETRYING'] } },
    })
    if (active) return active
    return tx.integrationJob.create({
      data: {
        storeId: input.storeId,
        connectionId: input.connectionId,
        type: input.type,
        generationId,
        idempotencyKey: `${input.type}:${input.connectionId}:${generationId ?? 'custom'}:${crypto.randomUUID()}`,
        payload: (input.payload ?? undefined) as any,
        maxAttempts: input.maxAttempts ?? 5,
        // Set from the app clock so due-detection is consistent with runDueJobs
        // (avoids DB/app clock skew leaving a fresh job briefly "not due").
        availableAt: new Date(),
      },
    })
  })
}

/**
 * Manual retry from backoffice (plan §M9). Idempotent: an already-SUCCEEDED job
 * is a no-op (returns as-is), so retrying a job that meanwhile succeeded never
 * re-runs it. A FAILED/RETRYING/PENDING job is made due again; if its bounded
 * attempts were exhausted, the ceiling is lifted by one so runDueJobs re-runs it.
 */
export async function retryJob(jobId: string, client: PrismaClient = defaultPrisma): Promise<IntegrationJob | null> {
  assertCapability('commerce-core')

  const job = await client.integrationJob.findUnique({ where: { id: jobId } })
  if (!job) return null
  if (job.status === 'SUCCEEDED') return job
  if (job.status === 'RUNNING') throw new ExchangeError('job_running')
  const source = await requireActiveSource(job.connectionId, job.storeId, client)
  if (source.provider === 'ONE_C') {
    if (!job.generationId) throw new ExchangeError('generation_required')
    await requireGeneration(source.id, job.generationId, client)
  }
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${job.connectionId}:${job.type}`}, 0))::text`
    const [current] = await tx.$queryRaw<IntegrationJob[]>`SELECT * FROM "IntegrationJob" WHERE id = ${job.id} FOR UPDATE`
    if (!current) return null
    if (current.status === 'SUCCEEDED') return current
    if (current.status === 'RUNNING') throw new ExchangeError('job_running')
    if (current.dependsOnId && (await tx.integrationJob.findUnique({ where: { id: current.dependsOnId } }))?.status !== 'SUCCEEDED') throw new ExchangeError('previous_stage_incomplete')
    const active = await tx.integrationJob.findFirst({ where: { id: { not: job.id }, connectionId: job.connectionId, type: job.type, generationId: job.generationId, status: { in: ['PENDING', 'RUNNING', 'RETRYING'] } } })
    if (active) throw new ExchangeError('job_already_active')
    return tx.integrationJob.update({ where: { id: job.id }, data: {
      status: 'PENDING', availableAt: new Date(), lastError: null, finishedAt: null, leaseToken: null, leaseExpiresAt: null,
      maxAttempts: current.attempts >= current.maxAttempts ? current.attempts + 1 : current.maxAttempts,
    } })
  })
}

/** Execution outcome and scheduling state are distinct: RETRYING is not success. */
export async function runJob(job: IntegrationJob, deps: { provider?: OperationalProvider; resolveProvider?: () => OperationalProvider; onClaim?: () => Promise<unknown> }, client: PrismaClient = defaultPrisma): Promise<RunResult> {
  assertCapability('commerce-core')

  const source = await requireActiveSource(job.connectionId, job.storeId, client)
  const claimed = await client.$transaction(async tx => {
    const [current] = await tx.$queryRaw<IntegrationJob[]>`SELECT * FROM "IntegrationJob"
      WHERE id = ${job.id} AND status IN ('PENDING', 'RETRYING') AND "availableAt" <= clock_timestamp()
      AND attempts < "maxAttempts" AND ("dependsOnId" IS NULL OR EXISTS (
        SELECT 1 FROM "IntegrationJob" predecessor WHERE predecessor.id = "IntegrationJob"."dependsOnId" AND predecessor.status = 'SUCCEEDED'
      )) FOR UPDATE SKIP LOCKED`
    if (!current) throw new ExchangeError('job_not_claimable')
    const token = crypto.randomUUID()
    const [owned] = await tx.$queryRaw<IntegrationJob[]>`UPDATE "IntegrationJob"
      SET status = 'RUNNING', attempts = attempts + 1, "leaseToken" = ${token},
          "leaseExpiresAt" = clock_timestamp() + ${LEASE_MS} * interval '1 millisecond',
          "startedAt" = COALESCE("startedAt", clock_timestamp()), "finishedAt" = NULL, "updatedAt" = clock_timestamp()
      WHERE id = ${current.id} RETURNING *`
    const attemptRow = await tx.integrationAttempt.create({ data: { jobId: owned.id, attempt: owned.attempts, status: 'RUNNING' } })
    return { owned, attemptRow, token }
  })
  job = claimed.owned
  const attempt = job.attempts, attemptRow = claimed.attemptRow
  const execution = executionLease(client, { table: 'IntegrationJob', id: job.id, token: claimed.token })
  client = execution.client
  async function issues(): Promise<ImportIssue[]> {
    const rows = await client.integrationError.findMany({ where: { jobId: job.id, createdAt: { gte: attemptRow.startedAt }, OR: [{ code: { not: 'JOB_FAILED' } }, { context: { path: ['attemptId'], equals: attemptRow.id } }] }, orderBy: { createdAt: 'asc' }, take: 20, select: { code: true, message: true, context: true } })
    return rows.map(row => ({ code: row.code, message: row.message, ...(row.context && typeof row.context === 'object' && 'externalId' in row.context && typeof row.context.externalId === 'string' ? { externalId: row.context.externalId } : {}) }))
  }
  async function finish(result: RunResult, terminal: boolean) {
    const status = result.status.toUpperCase() as 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'RETRYING' | 'SKIPPED'
    await client.$transaction(async tx => {
      await tx.integrationJob.update({ where: { id: job.id }, data: { status, leaseToken: null, leaseExpiresAt: null, finishedAt: terminal ? new Date() : null, lastError: result.message ?? null,
        ...(terminal ? {} : { availableAt: new Date(Date.now() + retryDelay(attempt)) }) } })
      await tx.integrationAttempt.update({ where: { id: attemptRow.id }, data: { status: result.outcome === 'partial' ? 'PARTIAL' : result.outcome === 'failed' ? 'FAILED' : status, stats: result as any, error: result.message, finishedAt: new Date() } })
    })
    return result
  }
  let committedStats: ImportCounters = { imported: 0, failed: 0 }
  try {
    await deps.onClaim?.()
    const rawProvider = deps.provider ?? deps.resolveProvider?.()
    if (!rawProvider) throw new Error('provider_not_configured')
    const provider = execution.provider(rawProvider)
    if (source.provider === 'ONE_C') {
      if (!job.generationId || provider.generationId !== job.generationId || provider.sourceId !== source.id) throw new ExchangeError('job_generation_mismatch')
      await requireGeneration(source.id, job.generationId, client)
    }
    const handler = handlers[job.type]
    if (!handler) throw new Error(`No handler registered for job type "${job.type}"`)
    if ((job.type === JOB_PRICES_IMPORT && !provider.pullPrices) || (job.type === JOB_AVAILABILITY_IMPORT && !provider.pullAvailability)) {
      return await finish({ jobId: job.id, type: job.type, status: 'skipped', outcome: 'skipped', message: 'provider_stream_not_supported' }, true)
    }
    const stats = await handler({ prisma: client, job, provider })
    committedStats = stats
    const outcome = classifyImport(stats)
    const result: RunResult = { jobId: job.id, type: job.type, outcome, status: outcome === 'success' ? 'succeeded' : outcome === 'partial' ? 'partial' : 'failed', stats }
    if (outcome !== 'success') { result.message = 'import_rows_failed'; result.issues = await issues() }
    return await finish(result, true)
  } catch (error) {
    const failure = importFailure(error), message = failure.message
    const stats = error instanceof ImportExecutionError ? error.stats : committedStats
    const outcome = classifyImport(stats, true)
    const terminal = error instanceof ExchangeError || attempt >= job.maxAttempts
    const result = { jobId: job.id, type: job.type, outcome: outcome as 'failed' | 'partial', status: terminal ? 'failed' as const : 'retrying' as const, message, stats, failure }
    let finished: boolean
    try {
      finished = await execution.recordJobFailure({ attemptId: attemptRow.id, attempt, terminal, result })
    } catch (completionError) {
      // Even an unavailable diagnostic store must not replace the primary error.
      console.error('integration_failure_persistence_failed', { jobId: job.id, attemptId: attemptRow.id, failure: importFailure(completionError) })
      throw error
    }
    if (!finished) throw error
    return result
  } finally { await execution.stop() }
}

/** Process due jobs (PENDING/RETRYING with availableAt <= now). In-process; no broker. */
export async function runDueJobs(
  options: { now?: Date; limit?: number; storeId?: string; recover?: boolean; resolveProvider?: (connection: IntegrationConnection, generationId?: string) => OperationalProvider } = {},
  client: PrismaClient = defaultPrisma,
): Promise<RunResult[]> {
  assertCapability('commerce-core')

  if (options.recover !== false) await recoverExpiredWork(client, 100, options.storeId)
  const now = options.now ?? new Date()
  const resolve = options.resolveProvider ?? ((connection, generationId) => getProvider(connection, generationId))
  const jobs = await client.integrationJob.findMany({
    where: { ...(options.storeId ? { storeId: options.storeId } : {}), OR: [{ dependsOnId: null }, { dependsOn: { status: 'SUCCEEDED' } }], status: { in: ['PENDING', 'RETRYING'] }, availableAt: { lte: now }, connection: { enabled: true, sourceState: 'ACTIVE' } },
    orderBy: { availableAt: 'asc' },
    take: options.limit ?? 10,
    include: { connection: true },
  })
  const results: RunResult[] = []
  for (const job of jobs) {
    try { results.push(await runJob(job, { resolveProvider: () => resolve(job.connection, job.generationId ?? undefined), onClaim: job.syncRunId ? () => refreshQueuedSyncRuns(client, job.storeId) : undefined }, client)) }
    catch (error) { if (!(error instanceof ExchangeError && error.code === 'job_not_claimable')) throw error }
  }
  return results
}
