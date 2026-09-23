import { spawn } from 'node:child_process'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { enqueueJob, retryJob, runJob, runDueJobs, JOB_CATALOG_IMPORT } from '@/lib/integrations/jobs'
import { executionLease } from '@/lib/integrations/lease'
import { recoverExpiredWork } from '@/lib/integrations/recovery'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import { runSourceSync } from '@/lib/integrations/sync'
import { IMPORT_STAGES } from '@/lib/integrations/import-result'
const db = new PrismaClient(), other = new PrismaClient()
let storeId: string, connectionId: string
const healthy = () => createMockProvider({ products: [{ externalId: 'one', sku: 'ONE', name: 'One' }] })
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r }); return { promise, release } }
const enqueue = (maxAttempts = 3) => enqueueJob({ storeId, connectionId, type: JOB_CATALOG_IMPORT, maxAttempts }, db)
beforeEach(async () => {
  storeId = (await db.store.create({ data: { slug: randomUUID(), name: 'R14' } })).id
  connectionId = (await db.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'lease', sourceState: 'ACTIVE', enabled: true, environment: 'TEST' } })).id
})
afterEach(async () => {
  await db.inbox.deleteMany({ where: { storeId } }); await db.integrationError.deleteMany({ where: { storeId } }); await db.providerSnapshot.deleteMany({ where: { storeId } }); await db.store.delete({ where: { id: storeId } })
})
afterAll(async () => { await db.$disconnect(); await other.$disconnect() })
it('parallel enqueues reuse one active job', async () => {
  const jobs = await Promise.all(Array.from({ length: 10 }, (_, i) => enqueueJob({ storeId, connectionId, type: JOB_CATALOG_IMPORT }, i % 2 ? db : other)))
  expect(new Set(jobs.map(j => j.id)).size).toBe(1)
  expect(await db.integrationJob.count({ where: { connectionId } })).toBe(1)
})
it('two clients with the same stale snapshot enter the provider only once', async () => {
  const job = await enqueue(), entered = gate(), done = gate()
  const pull = vi.fn(async () => { entered.release(); await done.promise; return { items: [] } })
  const running = runJob(job, { provider: { ...healthy(), pullProducts: pull } }, db)
  try {
    await entered.promise
    await expect(runJob(job, { provider: { ...healthy(), pullProducts: pull } }, other)).rejects.toMatchObject({ code: 'job_not_claimable' })
    await expect(retryJob(job.id, other)).rejects.toMatchObject({ code: 'job_running' })
    expect(await db.integrationAttempt.count({ where: { jobId: job.id } })).toBe(1)
  } finally { done.release(); await running }
  expect(pull).toHaveBeenCalledTimes(1)
  await expect(runJob(job, { provider: healthy() }, other)).rejects.toMatchObject({ code: 'job_not_claimable' })
})
it('parallel due runners tolerate losing the claim without duplicate attempts', async () => {
  const job = await enqueue(), pull = vi.fn(async () => ({ items: [] }))
  const results = await Promise.all([runDueJobs({ resolveProvider: () => ({ ...healthy(), pullProducts: pull }) }, db), runDueJobs({ resolveProvider: () => ({ ...healthy(), pullProducts: pull }) }, other)])
  expect(results.flat().filter(r => r.jobId === job.id)).toHaveLength(1)
  expect(pull).toHaveBeenCalledTimes(1)
})
it('future jobs and exhausted jobs cannot bypass the scheduler via runJob', async () => {
  const job = await enqueue(1), resolveProvider = vi.fn(healthy)
  await db.integrationJob.update({ where: { id: job.id }, data: { availableAt: new Date(Date.now() + 60_000) } })
  await expect(runJob(job, { resolveProvider }, db)).rejects.toMatchObject({ code: 'job_not_claimable' })
  await db.integrationJob.update({ where: { id: job.id }, data: { availableAt: new Date(0), attempts: 1 } })
  await expect(runJob(job, { resolveProvider }, db)).rejects.toMatchObject({ code: 'job_not_claimable' })
  await recoverExpiredWork(db)
  expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'FAILED', attempts: 1 })
  expect(resolveProvider).not.toHaveBeenCalled()
})
it('crashed attempts recover exactly once, back off, and stop at the ceiling', async () => {
  const job = await enqueue(2)
  await db.integrationJob.update({ where: { id: job.id }, data: { status: 'RUNNING', attempts: 1, leaseToken: 'dead', leaseExpiresAt: new Date(0) } })
  await db.integrationAttempt.create({ data: { jobId: job.id, attempt: 1, status: 'RUNNING' } })
  await Promise.all([recoverExpiredWork(db), recoverExpiredWork(other)])
  const recovered = await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })
  expect(recovered).toMatchObject({ status: 'RETRYING', attempts: 1, leaseToken: null, lastError: 'execution_lease_expired' })
  expect(recovered.availableAt.getTime()).toBeGreaterThan(Date.now() - 100)
  expect(await db.integrationAttempt.findFirstOrThrow({ where: { jobId: job.id } })).toMatchObject({ status: 'FAILED', error: 'execution_lease_expired' })
  expect(await db.integrationError.count({ where: { jobId: job.id, code: 'JOB_LEASE_RECOVERED' } })).toBe(1)
  await db.integrationJob.update({ where: { id: job.id }, data: { status: 'RUNNING', attempts: 2, leaseToken: 'dead2', leaseExpiresAt: new Date(0) } })
  await recoverExpiredWork(db)
  expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'FAILED', attempts: 2 })
})
it('late catalog response is fenced before any product or checkpoint mutation', async () => {
  const job = await enqueue(), entered = gate(), done = gate()
  const running = runJob(job, { provider: { ...healthy(), pullProducts: async () => { entered.release(); await done.promise; return { items: [{ externalId: 'stale', sku: 'STALE', name: 'Stale' }] } } } }, db)
  const rejected = expect(running).rejects.toMatchObject({ code: 'execution_lease_lost' })
  await entered.promise
  await other.integrationJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(0) } })
  await recoverExpiredWork(other)
  const next = await retryJob(job.id, other)
  expect((await runJob(next!, { provider: healthy() }, other)).status).toBe('succeeded')
  done.release(); await rejected
  expect(await db.productVariant.findMany({ where: { storeId }, select: { sku: true } })).toEqual([{ sku: 'ONE' }])
  expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'SUCCEEDED', attempts: 2 })
})
it('stale owner cannot commit a business transaction or replace the new result', async () => {
  const job = await enqueue()
  await db.integrationJob.update({ where: { id: job.id }, data: { status: 'RUNNING', leaseToken: 'new', leaseExpiresAt: new Date(Date.now() + 60_000) } })
  const old = executionLease(db, { table: 'IntegrationJob', id: job.id, token: 'old' })
  try {
    await expect(old.client.product.create({ data: { storeId, canonicalName: 'stale' } })).rejects.toMatchObject({ code: 'execution_lease_lost' })
    await expect(old.client.$transaction(tx => tx.integrationJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED' } }))).rejects.toMatchObject({ code: 'execution_lease_lost' })
    expect(await db.product.count({ where: { storeId } })).toBe(0)
  } finally { await old.stop() }
})
it('recovery skips a locked atomic import transaction and sees its renewed lease after commit', async () => {
  const job = await enqueue(), entered = gate(), done = gate()
  await db.integrationJob.update({ where: { id: job.id }, data: { status: 'RUNNING', leaseToken: 'live', leaseExpiresAt: new Date(Date.now() + 1_000) } })
  const owner = executionLease(db, { table: 'IntegrationJob', id: job.id, token: 'live' })
  const writing = owner.client.$transaction(async tx => {
    await tx.integrationJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(0) } }); entered.release(); await done.promise
    await tx.product.create({ data: { storeId, canonicalName: 'committed' } })
  })
  try { await entered.promise; await new Promise(resolve => setTimeout(resolve, 1_100)); expect((await recoverExpiredWork(other)).jobs).toBe(0) }
  finally { done.release(); await writing; await owner.stop() }
  expect((await recoverExpiredWork(other)).jobs).toBe(0)
  expect(await db.product.count({ where: { storeId } })).toBe(1)
})
it('heartbeat renews an idle provider wait without starting a second attempt', async () => {
  const job = await enqueue(), entered = gate(), done = gate()
  const running = runJob(job, { provider: { ...healthy(), pullProducts: async () => { entered.release(); await done.promise; return { items: [] } } } }, db)
  try {
    await entered.promise
    const initial = (await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).leaseExpiresAt!
    await expect.poll(async () => (await other.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).leaseExpiresAt!.getTime(), { timeout: 24_000, interval: 500 }).toBeGreaterThan(initial.getTime() + 10_000)
    expect((await recoverExpiredWork(other)).jobs).toBe(0)
  } finally { done.release(); await running }
})
it('legacy NULL leases and abandoned three-stage reports are recovered', async () => {
  const job = await enqueue()
  await db.integrationJob.update({ where: { id: job.id }, data: { status: 'RUNNING', attempts: 1 } })
  const run = await db.syncRun.create({ data: { connectionId, entityType: 'commerce.sync', status: 'RUNNING', stats: { runId: 'legacy', generationId: null, outcome: 'running', results: IMPORT_STAGES.map((type, index) => index === 0 ? { type, status: 'succeeded', outcome: 'success', stats: { imported: 2, failed: 0 } } : { type, status: index === 1 ? 'running' : 'pending' }) } } })
  await recoverExpiredWork(db)
  expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'RETRYING' })
  expect(await db.syncRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ status: 'PARTIAL', stats: { outcome: 'partial', results: [{ outcome: 'success' }, { outcome: 'failed' }, { outcome: 'skipped' }] } })
})
it('a complete source sync clears coordinator and job leases', async () => {
  const connection = await db.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
  const report = await runSourceSync(connection, undefined, db, healthy)
  expect(report.outcome).toBe('success')
  expect(await db.syncRun.findUniqueOrThrow({ where: { id: report.runId } })).toMatchObject({ status: 'SUCCEEDED', leaseToken: null, leaseExpiresAt: null })
  expect(await db.integrationJob.count({ where: { connectionId, leaseToken: { not: null } } })).toBe(0)
})
it('concurrent manual retries grant only one extra attempt, and cannot duplicate another active job', async () => {
  const job = await enqueue(1)
  await db.integrationJob.update({ where: { id: job.id }, data: { status: 'FAILED', attempts: 1 } })
  const results = await Promise.all([retryJob(job.id, db), retryJob(job.id, other)])
  expect(results.map(j => j!.maxAttempts)).toEqual([2, 2])
  await db.integrationJob.update({ where: { id: job.id }, data: { status: 'FAILED' } })
  await enqueue()
  await expect(retryJob(job.id, db)).rejects.toMatchObject({ code: 'job_already_active' })
})

it('a killed process leaves a durable claim and resumes from the committed checkpoint in a new executor', async () => {
  const job = await enqueue()
  const child = spawn(process.execPath, ['node_modules/vite-node/vite-node.mjs', '--config', 'vitest.integration.config.mts', 'tests/fixtures/execution-crash.ts', job.id], { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`Child exited before crash barrier: ${code} ${output}`)))
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('R14_CRASH_READY')) resolve() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
  })
  try {
    await ready
    expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'RUNNING', attempts: 1 })
    expect(await db.syncCheckpoint.findFirstOrThrow({ where: { connectionId } })).toMatchObject({ processed: 1, completed: false })
  } finally { child.kill('SIGKILL'); await exited }
  await db.integrationJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(0) } })
  await recoverExpiredWork(other)
  const next = await retryJob(job.id, other)
  const result = await runJob(next!, { provider: createMockProvider({ products: [
    { externalId: 'first', sku: 'FIRST', name: 'First' }, { externalId: 'second', sku: 'SECOND', name: 'Second' },
  ], pageSize: 1 }) }, other)
  expect(result).toMatchObject({ status: 'succeeded', stats: { imported: 1 } })
  expect(await db.productVariant.count({ where: { storeId } })).toBe(2)
  expect(await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ attempts: 2, leaseToken: null })
  expect(await db.integrationAttempt.findMany({ where: { jobId: job.id }, orderBy: { attempt: 'asc' }, select: { attempt: true, status: true } })).toEqual([{ attempt: 1, status: 'FAILED' }, { attempt: 2, status: 'SUCCEEDED' }])
})

it('execution deadline rejects further writes without reopening an expired owner', async () => {
  const job = await enqueue()
  await db.integrationJob.update({ where: { id: job.id }, data: { status: 'RUNNING', leaseToken: 'bounded', leaseExpiresAt: new Date(Date.now() + 60_000) } })
  const execution = executionLease(db, { table: 'IntegrationJob', id: job.id, token: 'bounded' })
  const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000)
  try { expect(() => execution.assert()).toThrow('execution_lease_lost') }
  finally { clock.mockRestore(); await execution.stop() }
})
