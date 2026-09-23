import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { enqueueSourceSync, refreshQueuedSyncRuns } from '@/lib/integrations/sync-queue'
import { runWorkerTick } from '@/lib/integrations/worker'
import { runJob, retryJob } from '@/lib/integrations/jobs'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import type { SyncReport } from '@/lib/integrations/import-result'
const db = new PrismaClient(), other = new PrismaClient()
let storeId: string, connectionId: string
const connection = () => db.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
const enqueue = async () => enqueueSourceSync(await connection(), undefined, db)
const provider = () => createMockProvider({ products: [{ externalId: 'one', sku: 'ONE', name: 'One' }] })
const tick = (resolveProvider = provider) => runWorkerTick({ storeId, resolveProvider }, db)
const report = async (id: string) => (await db.syncRun.findUniqueOrThrow({ where: { id } })).stats as unknown as SyncReport
beforeEach(async () => {
  storeId = (await db.store.create({ data: { slug: randomUUID(), name: 'R15' } })).id
  connectionId = (await db.integrationConnection.create({ data: { storeId, name: 'queue', provider: 'CUSTOM', sourceState: 'ACTIVE', enabled: true, environment: 'TEST' } })).id
})
afterEach(async () => { vi.unstubAllEnvs(); await db.inbox.deleteMany({ where: { storeId } }); await db.integrationError.deleteMany({ where: { storeId } }); await db.providerSnapshot.deleteMany({ where: { storeId } }); await db.store.delete({ where: { id: storeId } }) })
afterAll(async () => { await db.$disconnect(); await other.$disconnect() })
it('enqueue is atomic, returns all three IDs, and concurrent submissions reuse the chain without executing it', async () => {
  const c = await connection()
  const reports = await Promise.all([enqueueSourceSync(c, undefined, db), enqueueSourceSync(c, undefined, other)])
  expect(reports[0]).toEqual(reports[1]); expect(reports[0].outcome).toBe('pending')
  expect(reports[0].results).toHaveLength(3)
  expect(await db.integrationJob.count({ where: { connectionId } })).toBe(3)
  expect(await db.product.count({ where: { storeId } })).toBe(0)
  expect(await db.integrationAttempt.count({ where: { job: { connectionId } } })).toBe(0)
})
it('three bounded ticks execute catalog then prices then stock on the same connection', async () => {
  const queued = await enqueue(), seen: string[] = []
  const resolve = vi.fn((c: { id: string }) => {
    expect(c.id).toBe(connectionId)
    return { ...provider(), pullProducts: async () => { seen.push('catalog'); return { items: [] } }, pullPrices: async () => { seen.push('prices'); return { items: [] } }, pullAvailability: async () => { seen.push('stock'); return { items: [] } } }
  })
  for (let i = 0; i < 3; i++) expect((await tick(resolve as any)).processed).toBe(1)
  expect(seen).toEqual(['catalog', 'prices', 'stock'])
  expect((await report(queued.runId)).outcome).toBe('success')
  expect((await tick()).processed).toBe(0)
})
it('direct run and manual retry cannot bypass an unfinished dependency', async () => {
  const queued = await enqueue(), price = await db.integrationJob.findUniqueOrThrow({ where: { id: queued.results[1].jobId } })
  await expect(runJob(price, { provider: provider() }, db)).rejects.toMatchObject({ code: 'job_not_claimable' })
  await expect(retryJob(price.id, db)).rejects.toMatchObject({ code: 'previous_stage_incomplete' })
  expect(await db.integrationAttempt.count({ where: { jobId: price.id } })).toBe(0)
})
it('transient catalog failure blocks later stages until the scheduled retry succeeds', async () => {
  const queued = await enqueue()
  await tick(() => ({ ...provider(), pullProducts: async () => { throw new Error('offline') } }))
  expect((await report(queued.runId)).results.map(r => r.status)).toEqual(['retrying', 'pending', 'pending'])
  expect((await tick()).processed).toBe(0)
  await db.integrationJob.update({ where: { id: queued.results[0].jobId }, data: { availableAt: new Date(0) } })
  await tick(); await tick(); await tick()
  expect((await report(queued.runId)).outcome).toBe('success')
  expect(await db.integrationJob.findUniqueOrThrow({ where: { id: queued.results[0].jobId } })).toMatchObject({ attempts: 2 })
})
it('terminal partial failure skips dependent jobs and preserves the historical report on manual retry', async () => {
  const queued = await enqueue()
  await tick(() => createMockProvider({ products: [{ externalId: 'bad' }] }))
  expect((await report(queued.runId)).results.map(r => r.status)).toEqual(['failed', 'skipped', 'skipped'])
  await retryJob(queued.results[0].jobId!, db); await tick()
  expect((await report(queued.runId)).outcome).toBe('failed')
  expect((await db.integrationJob.findUniqueOrThrow({ where: { id: queued.results[1].jobId } })).attempts).toBe(0)
})
it('crash between job commit and report projection still advances the chain after restart', async () => {
  const queued = await enqueue()
  await runJob(await db.integrationJob.findUniqueOrThrow({ where: { id: queued.results[0].jobId } }), { provider: provider() }, db)
  expect((await report(queued.runId)).outcome).toBe('pending')
  await tick(); await tick()
  expect((await report(queued.runId)).outcome).toBe('success')
  expect((await db.integrationJob.findUniqueOrThrow({ where: { id: queued.results[0].jobId } })).attempts).toBe(1)
})
it('only one worker tick owns the installation while a provider is waiting', async () => {
  const queued = await enqueue()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(r => { enter = r }), gate = new Promise<void>(r => { release = r })
  const running = tick(() => ({ ...provider(), pullProducts: async () => { enter(); await gate; return { items: [] } } }))
  try { await entered; expect((await report(queued.runId)).outcome).toBe('running'); expect((await report(queued.runId)).results[0].status).toBe('running'); expect(await runWorkerTick({ storeId, resolveProvider: provider }, other)).toEqual({ busy: true, processed: 0 }) }
  finally { release(); await running }
  expect((await db.integrationWorker.findUniqueOrThrow({ where: { storeId } })).leaseToken).toBeNull()
})
it('lost worker and job leases recover without closing the queued batch', async () => {
  const queued = await enqueue()
  await db.integrationWorker.create({ data: { id: `integrations:${storeId}`, storeId, leaseToken: 'dead', leaseExpiresAt: new Date(0) } })
  await db.integrationJob.update({ where: { id: queued.results[0].jobId }, data: { status: 'RUNNING', attempts: 1, leaseToken: 'dead', leaseExpiresAt: new Date(0) } })
  await db.integrationAttempt.create({ data: { jobId: queued.results[0].jobId!, attempt: 1, status: 'RUNNING' } })
  await tick()
  expect((await report(queued.runId)).outcome).toBe('running')
  expect((await report(queued.runId)).results[0].status).toBe('retrying')
  await db.integrationJob.update({ where: { id: queued.results[0].jobId }, data: { availableAt: new Date(0) } })
  await tick(); await tick(); await tick()
  expect((await report(queued.runId)).outcome).toBe('success')
})
it('invalid license leaves queued jobs untouched and consumes no attempt', async () => {
  const queued = await enqueue()
  vi.stubEnv('LICENSE_ENFORCE', '1'); vi.stubEnv('LICENSE_GRANT_PATH', 'missing-r15-license.json')
  await expect(tick()).rejects.toMatchObject({ status: 'ABSENT' })
  expect((await db.integrationJob.findUniqueOrThrow({ where: { id: queued.results[0].jobId } })).attempts).toBe(0)
})
it('a stop signal before a work item drains without claiming another job', async () => {
  await enqueue()
  const result = await runWorkerTick({ storeId, shouldStop: () => true }, db)
  expect(result.processed).toBe(0)
  expect(await db.integrationAttempt.count({ where: { job: { connectionId } } })).toBe(0)
})

async function processWorker(runId: string) {
  execFileSync(process.execPath, ['scripts/build-worker.mjs'], { windowsHide: true, stdio: 'pipe' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-r15-worker-'))
  const store = await db.store.findUniqueOrThrow({ where: { id: storeId } })
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ store: { code: store.slug, name: 'R15 worker' }, modules: ['commerce-core'], integration: { provider: 'custom' } }))
  const child = spawn(process.execPath, ['dist/integration-worker.cjs'], { windowsHide: true, env: { ...process.env, NODE_ENV: 'test', LICENSE_ENFORCE: '0', STORE_PROFILE_PATH: path.join(dir, 'profile.json'), INTEGRATION_WORKER_INTERVAL_MS: '250' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  try {
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(`Worker exited: ${output}`)
      return (await db.syncRun.findUniqueOrThrow({ where: { id: runId } })).status
    }, { timeout: 15_000, interval: 200 }).not.toMatch(/^(PENDING|RUNNING)$/)
  } finally { child.kill('SIGTERM'); await exited }
  return output
}
it('the standalone process polls, recovers a dead job and completes all stages without HTTP', async () => {
  const queued = await enqueue()
  await db.integrationConnection.update({ where: { id: connectionId }, data: { config: { fixtures: [{ externalId: 'process', sku: 'PROCESS', name: 'Process' }] } } })
  await db.integrationJob.update({ where: { id: queued.results[0].jobId }, data: { status: 'RUNNING', attempts: 1, leaseToken: 'crashed', leaseExpiresAt: new Date(0) } })
  await db.integrationAttempt.create({ data: { jobId: queued.results[0].jobId!, attempt: 1, status: 'RUNNING' } })
  const output = await processWorker(queued.runId)
  expect(output).toContain('integration_worker_tick')
  expect((await report(queued.runId)).outcome).toBe('success')
  expect(await db.productVariant.count({ where: { storeId, sku: 'PROCESS' } })).toBe(1)
  expect((await db.integrationJob.findUniqueOrThrow({ where: { id: queued.results[0].jobId } })).attempts).toBe(2)
})
it('the standalone scheduler respects backoff and stops a failing chain at its attempt ceiling', async () => {
  const queued = await enqueue()
  await db.integrationConnection.update({ where: { id: connectionId }, data: { provider: 'MOYSKLAD' } })
  await db.integrationJob.update({ where: { id: queued.results[0].jobId }, data: { maxAttempts: 2 } })
  await processWorker(queued.runId)
  const attempts = await db.integrationAttempt.findMany({ where: { jobId: queued.results[0].jobId }, orderBy: { attempt: 'asc' } })
  expect(attempts).toHaveLength(2)
  expect(attempts[1].startedAt.getTime() - attempts[0].finishedAt!.getTime()).toBeGreaterThanOrEqual(1_000)
  expect((await report(queued.runId)).results.map(r => r.status)).toEqual(['failed', 'skipped', 'skipped'])
})

it('retiring the pinned source closes its waiting chain instead of sending it to the replacement', async () => {
  const queued = await enqueue()
  await db.integrationConnection.update({ where: { id: connectionId }, data: { sourceState: 'RETIRED', enabled: false } })
  await db.integrationConnection.create({ data: { storeId, name: 'replacement', provider: 'CUSTOM', sourceState: 'ACTIVE', enabled: true, environment: 'TEST' } })
  const resolve = vi.fn(provider)
  await tick(resolve)
  expect(resolve).not.toHaveBeenCalled()
  expect((await report(queued.runId)).results.map(r => r.status)).toEqual(['failed', 'skipped', 'skipped'])
  expect((await report(queued.runId)).error).toBe('source_not_active')
})
