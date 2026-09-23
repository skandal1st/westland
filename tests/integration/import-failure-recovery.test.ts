import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Prisma, PrismaClient } from '@prisma/client'
import { enqueueJob, retryJob, runJob, JOB_CATALOG_IMPORT, JOB_PRICES_IMPORT, JOB_AVAILABILITY_IMPORT } from '@/lib/integrations/jobs'
import { executionLease } from '@/lib/integrations/lease'
import { recoverExpiredWork } from '@/lib/integrations/recovery'
import { enqueueSourceSync, refreshQueuedSyncRuns } from '@/lib/integrations/sync-queue'
import { runWorkerTick } from '@/lib/integrations/worker'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import type { SyncReport } from '@/lib/integrations/import-result'

const db = new PrismaClient(), other = new PrismaClient()
let storeId: string, connectionId: string
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
const healthy = () => createMockProvider({ products: [{ externalId: 'one', sku: 'ONE', name: 'One' }] })
const connection = () => db.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
const report = async (id: string) => (await db.syncRun.findUniqueOrThrow({ where: { id } })).stats as unknown as SyncReport
beforeEach(async () => {
  storeId = (await db.store.create({ data: { slug: randomUUID(), name: 'R16.2' } })).id
  connectionId = (await db.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'failure', sourceState: 'ACTIVE', enabled: true, environment: 'TEST' } })).id
})
afterEach(async () => {
  vi.restoreAllMocks()
  await db.inbox.deleteMany({ where: { storeId } }); await db.integrationError.deleteMany({ where: { storeId } }); await db.providerSnapshot.deleteMany({ where: { storeId } }); await db.store.delete({ where: { id: storeId } })
})
afterAll(async () => { await db.$disconnect(); await other.$disconnect() })

async function oneC() {
  const source = await db.integrationConnection.update({ where: { id: connectionId }, data: { provider: 'ONE_C' } })
  const generation = await db.onecGeneration.create({ data: { connectionId, sourceRevision: source.exchangeRevision, files: [], digest: randomUUID() } })
  const queued = await enqueueSourceSync(source, generation.id, db)
  const provider = { ...createMockProvider({ provider: 'ONE_C', products: [{ externalId: 'one', sku: 'ONE', name: 'One' }] }), sourceId: connectionId, generationId: generation.id }
  return { queued, provider, job: await db.integrationJob.findUniqueOrThrow({ where: { id: queued.results[0].jobId } }) }
}

/** Real Prisma timeout of the ONE_C atomic write; only test durations are shortened.
 * The committed lease expires by PostgreSQL's actual clock during the transaction.
 * Renewal, products and checkpoint inside that transaction all roll back together.
 */
function timedOutClient(jobId: string, expireWorker = false) {
  let primary: unknown
  const client = new Proxy(db, { get(target, key) {
    if (key !== '$transaction') return Reflect.get(target, key)
    return async (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number; maxWait?: number }) => {
      if (options?.timeout !== 120_000) return target.$transaction(work, options)
      await other.$executeRaw`UPDATE "IntegrationJob" SET "leaseExpiresAt" = clock_timestamp() + interval '1 second' WHERE id = ${jobId}`
      if (expireWorker) await other.$executeRaw`UPDATE "IntegrationWorker" SET "leaseExpiresAt" = clock_timestamp() + interval '1 second' WHERE "storeId" = ${storeId}`
      try {
        return await target.$transaction(async tx => {
          await work(tx)
          expect(await tx.product.count({ where: { storeId } })).toBe(1)
          await pause(1_700)
          return tx.product.count({ where: { storeId } }) // P2028, not a fabricated Error.
        }, { ...options, timeout: 1_500 })
      } catch (error) { primary = error; throw error }
    }
  } }) as PrismaClient
  return { client, primary: () => primary }
}

it.each([1, 3])('real atomic P2028 after natural lease expiry closes attempt and queued run (maxAttempts=%i)', async maxAttempts => {
  const { queued, provider, job } = await oneC()
  await db.integrationJob.update({ where: { id: job.id }, data: { maxAttempts } })
  const injected = timedOutClient(job.id)
  const result = await runJob(job, { provider }, injected.client)
  expect(injected.primary()).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
  expect(result).toMatchObject({ status: maxAttempts === 1 ? 'failed' : 'retrying', outcome: 'failed', failure: { code: 'P2028' }, stats: { imported: 0, failed: 0 } })
  expect(result.message).toBe((injected.primary() as Error).message)
  expect(await db.product.count({ where: { storeId } })).toBe(0)
  expect(await db.syncCheckpoint.count({ where: { connectionId } })).toBe(0)
  expect(await db.syncCursor.count({ where: { connectionId } })).toBe(0)
  expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: maxAttempts === 1 ? 'FAILED' : 'RETRYING', lastError: result.message, leaseToken: null, leaseExpiresAt: null })
  expect(await db.integrationAttempt.findFirstOrThrow({ where: { jobId: job.id } })).toMatchObject({ status: 'FAILED', error: result.message, stats: result, finishedAt: expect.any(Date) })
  expect((await recoverExpiredWork(other, 100, storeId)).jobs).toBe(0)
  await refreshQueuedSyncRuns(other, storeId)
  const saved = await report(queued.runId)
  expect(saved.results[0]).toMatchObject({ failure: { code: 'P2028' }, message: result.message, stats: { imported: 0 } })
  expect(saved.results.map(stage => stage.status)).toEqual(maxAttempts === 1 ? ['failed', 'skipped', 'skipped'] : ['retrying', 'pending', 'pending'])
  expect(saved.outcome).toBe(maxAttempts === 1 ? 'failed' : 'running')
})

it('expired outer worker lease cannot erase the inner job primary failure', async () => {
  const { queued, provider, job } = await oneC(), injected = timedOutClient(job.id, true)
  await expect(runWorkerTick({ storeId, resolveProvider: () => provider }, injected.client)).rejects.toMatchObject({ code: 'execution_lease_lost' })
  expect(await db.integrationAttempt.findFirstOrThrow({ where: { jobId: job.id } })).toMatchObject({ status: 'FAILED', stats: { failure: { code: 'P2028' } } })
  expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'RETRYING', leaseToken: null, lastError: (injected.primary() as Error).message })
  await refreshQueuedSyncRuns(other, storeId)
  expect((await report(queued.runId)).results[0]).toMatchObject({ status: 'retrying', failure: { code: 'P2028' } })
  expect(await db.product.count({ where: { storeId } })).toBe(0)
})

it('a late primary failure is diagnostic only after recovery and a successful successor', async () => {
  const queued = await enqueueSourceSync(await connection(), undefined, db)
  const job = await db.integrationJob.findUniqueOrThrow({ where: { id: queued.results[0].jobId } })
  const entered = gate(), done = gate(), primary = Object.assign(new Error('original_transport_failure'), { code: 'ECONNRESET' })
  const running = runJob(job, { provider: { ...healthy(), pullProducts: async () => { entered.release(); await done.promise; throw primary } } }, db)
  const rejection = expect(running).rejects.toMatchObject({ cause: primary, code: 'ECONNRESET' })
  try {
    await entered.promise
    await other.$executeRaw`UPDATE "IntegrationJob" SET "leaseExpiresAt" = clock_timestamp() + interval '100 milliseconds' WHERE id = ${job.id}`
    await pause(150)
    expect((await recoverExpiredWork(other, 100, storeId)).jobs).toBe(1)
    const recovered = await db.integrationAttempt.findFirstOrThrow({ where: { jobId: job.id } })
    await runJob((await retryJob(job.id, other))!, { provider: healthy() }, other)
    for (const stage of queued.results.slice(1)) await runJob(await db.integrationJob.findUniqueOrThrow({ where: { id: stage.jobId } }), { provider: healthy() }, other)
    await refreshQueuedSyncRuns(other, storeId)
    const beforeJob = await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })
    const beforeAttempt = await db.integrationAttempt.findFirstOrThrow({ where: { jobId: job.id, attempt: 2 } })
    const beforeRun = await db.syncRun.findUniqueOrThrow({ where: { id: queued.runId } })
    done.release(); await rejection
    await refreshQueuedSyncRuns(other, storeId)
    expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(beforeJob)
    expect(await db.integrationAttempt.findUniqueOrThrow({ where: { id: beforeAttempt.id } })).toEqual(beforeAttempt)
    expect(await db.syncRun.findUniqueOrThrow({ where: { id: queued.runId } })).toEqual(beforeRun)
    expect(beforeRun.status).toBe('SUCCEEDED')
    expect(await db.integrationAttempt.findUniqueOrThrow({ where: { id: recovered.id } })).toMatchObject({ status: 'FAILED', finishedAt: recovered.finishedAt, error: primary.message, stats: { failure: { code: 'ECONNRESET' } } })
    expect(await db.integrationError.count({ where: { jobId: job.id, code: 'JOB_FAILED' } })).toBe(1)
    expect(await db.productVariant.count({ where: { storeId } })).toBe(1)
  } finally { done.release(); await rejection }
})

it('a lease that expires while waiting for a row lock cannot be revived after rollback', async () => {
  const job = await enqueueJob({ storeId, connectionId, type: JOB_CATALOG_IMPORT }, db), held = gate(), release = gate()
  await db.$executeRaw`UPDATE "IntegrationJob" SET status = 'RUNNING', attempts = 1, "leaseToken" = 'waiting', "leaseExpiresAt" = clock_timestamp() + interval '1 second' WHERE id = ${job.id}`
  await db.integrationAttempt.create({ data: { jobId: job.id, attempt: 1, status: 'RUNNING' } })
  const owner = executionLease(db, { table: 'IntegrationJob', id: job.id, token: 'waiting' })
  const rollback = new Error('rollback')
  const blocker = other.$transaction(async tx => { await tx.$queryRaw`SELECT id FROM "IntegrationJob" WHERE id = ${job.id} FOR UPDATE`; held.release(); await release.promise; throw rollback })
  const rolledBack = expect(blocker).rejects.toBe(rollback)
  await held.promise
  const rejected = expect(owner.assert()).rejects.toMatchObject({ code: 'execution_lease_lost' })
  try {
    await expect.poll(async () => (await other.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%IntegrationJob%') AS waiting`)[0].waiting).toBe(true)
    await pause(1_100)
  } finally { release.release(); await rolledBack; await rejected; await owner.stop() }
  expect((await recoverExpiredWork(other, 100, storeId)).jobs).toBe(1)
  expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'RETRYING', leaseToken: null })
})

it('failure persistence outage rethrows the original error and leaves recovery a durable claim', async () => {
  const job = await enqueueJob({ storeId, connectionId, type: JOB_CATALOG_IMPORT }, db)
  let unavailable = false
  const primary = Object.assign(new Error('primary_timeout'), { code: 'P2028' })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const client = new Proxy(db, { get(target, key) {
    if (key === '$transaction') return (...args: any[]) => { if (unavailable) throw new Error('diagnostics_unavailable'); return (target.$transaction as any)(...args) }
    return Reflect.get(target, key)
  } }) as PrismaClient
  await expect(runJob(job, { onClaim: async () => { unavailable = true; throw primary } }, client)).rejects.toBe(primary)
  expect(log).toHaveBeenCalledWith('integration_failure_persistence_failed', expect.objectContaining({ failure: { message: 'diagnostics_unavailable' } }))
  expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'RUNNING', attempts: 1 })
  await db.$executeRaw`UPDATE "IntegrationJob" SET "leaseExpiresAt" = clock_timestamp() + interval '100 milliseconds' WHERE id = ${job.id}`
  await pause(150)
  expect((await recoverExpiredWork(other, 100, storeId)).jobs).toBe(1)
})

it('committed page counters survive a transport failure after expiry', async () => {
  const job = await enqueueJob({ storeId, connectionId, type: JOB_CATALOG_IMPORT }, db)
  const result = await runJob(job, { provider: { ...healthy(), pullProducts: async cursor => {
    if (!cursor) return { items: [{ externalId: 'one', sku: 'ONE', name: 'One' }], nextCursor: 'second' }
    await other.$executeRaw`UPDATE "IntegrationJob" SET "leaseExpiresAt" = clock_timestamp() + interval '100 milliseconds' WHERE id = ${job.id}`
    await pause(150)
    throw Object.assign(new Error('connection reset after first page'), { code: 'ECONNRESET' })
  } } }, db)
  expect(result).toMatchObject({ outcome: 'partial', status: 'retrying', stats: { imported: 1, failed: 0 }, failure: { code: 'ECONNRESET' } })
  expect(await db.integrationAttempt.findFirstOrThrow({ where: { jobId: job.id } })).toMatchObject({ status: 'PARTIAL', stats: result })
  expect(await db.productVariant.count({ where: { storeId } })).toBe(1)
  expect(await db.syncCheckpoint.findFirstOrThrow({ where: { connectionId } })).toMatchObject({ processed: 1, completed: false })
})

it('failure completion is idempotent per claimed attempt', async () => {
  const job = await enqueueJob({ storeId, connectionId, type: JOB_CATALOG_IMPORT }, db)
  await db.integrationJob.update({ where: { id: job.id }, data: { status: 'RUNNING', attempts: 1, leaseToken: 'failed' } })
  const attempt = await db.integrationAttempt.create({ data: { jobId: job.id, attempt: 1, status: 'RUNNING' } })
  const execution = executionLease(db, { table: 'IntegrationJob', id: job.id, token: 'failed' })
  const failure = { attemptId: attempt.id, attempt: 1, terminal: false, result: { jobId: job.id, type: job.type, status: 'retrying' as const, outcome: 'failed' as const, message: 'primary', failure: { message: 'primary', code: 'P2028' } } }
  expect(await execution.recordJobFailure(failure)).toBe(true)
  const before = await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })
  expect(await execution.recordJobFailure(failure)).toBe(false)
  expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(before)
  expect(await db.integrationError.count({ where: { jobId: job.id, code: 'JOB_FAILED' } })).toBe(1)
  expect(() => execution.client.product.create({ data: { storeId, canonicalName: 'too late' } })).toThrow('execution_lease_lost')
})


it('a failed success-finalization retains already committed handler counters', async () => {
  const job = await enqueueJob({ storeId, connectionId, type: JOB_CATALOG_IMPORT }, db)
  const primary = new Error('completion_connection_lost')
  const client = new Proxy(db, { get(target, key) {
    if (key !== '$transaction') return Reflect.get(target, key)
    return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) => target.$transaction(tx => work(new Proxy(tx, { get(t, k) {
      if (k !== 'integrationJob') return Reflect.get(t, k)
      return new Proxy(t.integrationJob, { get(model, method) {
        if (method !== 'update') return Reflect.get(model, method)
        return (args: Parameters<typeof model.update>[0]) => { if (args.data.status === 'SUCCEEDED') throw primary; return model.update(args) }
      } })
    } })), options)
  } }) as PrismaClient
  const result = await runJob(job, { provider: healthy() }, client)
  expect(result).toMatchObject({ status: 'retrying', outcome: 'partial', stats: { imported: 1, failed: 0 }, message: primary.message })
  expect(await db.productVariant.count({ where: { storeId } })).toBe(1)
  expect(await db.integrationAttempt.findFirstOrThrow({ where: { jobId: job.id } })).toMatchObject({ status: 'PARTIAL', stats: result })
})


it.each([JOB_CATALOG_IMPORT, JOB_PRICES_IMPORT, JOB_AVAILABILITY_IMPORT])('%s preserves row error when its diagnostic write also fails', async type => {
  const job = await enqueueJob({ storeId, connectionId, type }, db)
  const client = new Proxy(db, { get(target, key) {
    if (key !== '$transaction') return Reflect.get(target, key)
    return (work: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: object) => target.$transaction(tx => work(new Proxy(tx, { get(t, k) {
      if (k !== 'integrationError') return Reflect.get(t, k)
      return new Proxy(t.integrationError, { get(model, method) {
        if (method !== 'create') return Reflect.get(model, method)
        return () => { throw new Error('secondary_log_failure') }
      } })
    } })), options)
  } }) as PrismaClient
  const result = await runJob(job, { provider: createMockProvider({ products: [{}], prices: [{}], availability: [{}] }) }, client)
  expect(result).toMatchObject({ status: 'retrying', outcome: 'failed', stats: { imported: 0, failed: 1 } })
  expect(result.message).not.toBe('secondary_log_failure')
  expect(result.message).toMatch(/missing/)
  expect(await db.integrationAttempt.findFirstOrThrow({ where: { jobId: job.id } })).toMatchObject({ error: result.message, stats: result })
})

it('late diagnostics from a superseded attempt do not leak into successor issues', async () => {
  const job = await enqueueJob({ storeId, connectionId, type: JOB_CATALOG_IMPORT }, db)
  const first = gate(), releaseFirst = gate(), second = gate(), releaseSecond = gate()
  const old = runJob(job, { provider: { ...healthy(), pullProducts: async () => { first.release(); await releaseFirst.promise; throw new Error('old_failure') } } }, db)
  const oldRejected = expect(old).rejects.toThrow('old_failure')
  await first.promise
  await other.$executeRaw`UPDATE "IntegrationJob" SET "leaseExpiresAt" = clock_timestamp() + interval '100 milliseconds' WHERE id = ${job.id}`
  await pause(150); await recoverExpiredWork(other, 100, storeId)
  const next = runJob((await retryJob(job.id, other))!, { provider: { ...healthy(), pullProducts: async () => { second.release(); await releaseSecond.promise; throw new Error('new_failure') } } }, other)
  try {
    await second.promise
    releaseFirst.release(); await oldRejected
    releaseSecond.release()
    const result = await next
    expect(result.issues).toEqual([{ code: 'JOB_FAILED', message: 'new_failure' }])
    expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ lastError: 'new_failure', attempts: 2 })
  } finally { releaseFirst.release(); releaseSecond.release(); await oldRejected; await next }
})
