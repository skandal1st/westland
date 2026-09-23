import { afterEach, beforeEach, afterAll, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import { enqueueJob, runJob, retryJob, JOB_CATALOG_IMPORT, JOB_PRICES_IMPORT, JOB_AVAILABILITY_IMPORT } from '@/lib/integrations/jobs'
import { runSourceSync } from '@/lib/integrations/sync'
import type { SyncReport } from '@/lib/integrations/import-result'
const db = new PrismaClient()
let storeId: string, connectionId: string
const good = { externalId: 'ok', sku: 'OK', name: 'Good' }, bad = { externalId: 'bad', sku: 'BAD' }
beforeEach(async () => {
  storeId = (await db.store.create({ data: { slug: randomUUID(), name: 'R13' } })).id
  connectionId = (await db.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'R13', sourceState: 'ACTIVE', enabled: true, environment: 'TEST' } })).id
})
afterEach(async () => {
  await db.inbox.deleteMany({ where: { storeId } }); await db.integrationError.deleteMany({ where: { storeId } }); await db.providerSnapshot.deleteMany({ where: { storeId } }); await db.store.delete({ where: { id: storeId } })
})
afterAll(async () => db.$disconnect())
const job = (type = JOB_CATALOG_IMPORT) => enqueueJob({ storeId, connectionId, type }, db)
const connection = () => db.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
it('all invalid rows are FAILED, with persisted counters and job-scoped reasons', async () => {
  const j = await job(), result = await runJob(j, { provider: createMockProvider({ products: [bad] }) }, db)
  expect(result).toMatchObject({ status: 'failed', outcome: 'failed', stats: { imported: 0, failed: 1 }, issues: [{ code: 'ITEM_IMPORT_FAILED', externalId: 'bad' }] })
  const saved = await db.integrationJob.findUniqueOrThrow({ where: { id: j.id }, include: { attemptsLog: true } })
  expect(saved.status).toBe('FAILED'); expect(saved.attemptsLog[0].stats).toMatchObject(result)
  expect((await db.syncCheckpoint.findFirstOrThrow({ where: { connectionId } })).completed).toBe(false)
})
it('mixed catalog rows are PARTIAL and a corrected retry replays the failed page', async () => {
  const j = await job(), first = await runJob(j, { provider: createMockProvider({ products: [good, bad], pageSize: 1 }) }, db)
  expect(first).toMatchObject({ status: 'partial', outcome: 'partial', stats: { imported: 1, failed: 1 } })
  const next = await retryJob(j.id, db)
  const second = await runJob(next!, { provider: createMockProvider({ products: [good, { ...bad, name: 'Fixed' }], pageSize: 1 }) }, db)
  expect(second).toMatchObject({ status: 'succeeded', outcome: 'success', stats: { imported: 1, skipped: 1, failed: 0 } })
  const checkpoint = await db.syncCheckpoint.findFirstOrThrow({ where: { connectionId } })
  expect(checkpoint).toMatchObject({ completed: true, failed: 0 })
  expect(await db.product.count({ where: { storeId } })).toBe(2)
})
it('poison row before transport failure cannot disappear behind the next-page cursor', async () => {
  const j = await job()
  const broken = createMockProvider({ products: [bad, good], pageSize: 1, failOnPage: 2 })
  expect((await runJob(j, { provider: broken }, db)).outcome).toBe('failed')
  const next = await retryJob(j.id, db)
  const result = await runJob(next!, { provider: createMockProvider({ products: [bad, good], pageSize: 1 }) }, db)
  expect(result).toMatchObject({ outcome: 'partial', stats: { imported: 1, failed: 1 } })
  expect((await db.syncCheckpoint.findFirstOrThrow({ where: { connectionId } })).completed).toBe(false)
})
it('transport failure after committed rows reports partial progress while scheduling retry', async () => {
  const j = await job()
  const result = await runJob(j, { provider: createMockProvider({ products: [good, { ...good, externalId: 'next', sku: 'NEXT' }], pageSize: 1, failOnPage: 2 }) }, db)
  expect(result).toMatchObject({ status: 'retrying', outcome: 'partial', stats: { imported: 1, failed: 0 } })
  expect((await db.integrationAttempt.findFirstOrThrow({ where: { jobId: j.id } })).status).toBe('PARTIAL')
  const next = await retryJob(j.id, db)
  const repeated = await runJob(next!, { provider: createMockProvider({ products: [good, { ...good, externalId: 'next', sku: 'NEXT' }], pageSize: 1, failOnPage: 2 }) }, db)
  expect(repeated).toMatchObject({ outcome: 'partial', stats: { imported: 0, previouslyProcessed: 1 } })
})
it.each([JOB_PRICES_IMPORT, JOB_AVAILABILITY_IMPORT])('%s cannot report success for only rejected rows', async type => {
  const j = await job(type)
  const result = await runJob(j, { provider: createMockProvider({ products: [], prices: [{ externalId: 'missing', amount: 10 }], availability: [{ externalId: 'missing', locationCode: 'none', available: 1 }] }) }, db)
  expect(result).toMatchObject({ status: 'failed', outcome: 'failed', stats: { imported: 0, failed: 1 } })
  expect(await db.integrationError.count({ where: { jobId: j.id } })).toBe(1)
})
it('absent provider capability is SKIPPED, not empty success', async () => {
  const j = await job(JOB_PRICES_IMPORT), provider = createMockProvider({ products: [] }); delete provider.pullPrices
  const result = await runJob(j, { provider }, db)
  expect(result).toMatchObject({ outcome: 'skipped', status: 'skipped', message: 'provider_stream_not_supported' })
  expect((await db.integrationJob.findUniqueOrThrow({ where: { id: j.id } })).status).toBe('SKIPPED')
})
it('batch persists all stages and distinguishes skipped dependencies after partial catalog', async () => {
  const report = await runSourceSync(await connection(), undefined, db, () => createMockProvider({ products: [good, bad] }))
  expect(report.outcome).toBe('partial')
  expect(report.results.map(r => r.status)).toEqual(['partial', 'skipped', 'skipped'])
  expect(report.results[1].message).toBe('previous_stage_incomplete')
  const persisted = await db.syncRun.findUniqueOrThrow({ where: { id: report.runId } })
  expect(persisted.status).toBe('PARTIAL'); expect(persisted.stats).toEqual(report)
  expect(await db.integrationJob.count({ where: { connectionId } })).toBe(1)
})
it('empty healthy stages are a valid full success, all bad catalog is failure', async () => {
  const empty = await runSourceSync(await connection(), undefined, db, () => createMockProvider({ products: [] }))
  expect(empty.outcome).toBe('success'); expect(empty.results).toHaveLength(3)
  const failed = await runSourceSync(await connection(), undefined, db, () => createMockProvider({ products: [bad] }))
  expect(failed.outcome).toBe('failed')
})
it('catalog success does not conceal price errors or execute availability', async () => {
  const report = await runSourceSync(await connection(), undefined, db, () => createMockProvider({ products: [good], prices: [{ externalId: 'missing', amount: 20 }] }))
  expect(report.outcome).toBe('partial'); expect(report.results.map(r => r.outcome)).toEqual(['success', 'failed', 'skipped'])
  expect(await db.integrationJob.count({ where: { connectionId, type: JOB_AVAILABILITY_IMPORT } })).toBe(0)
})
it('registry failure is recorded as failure with three stage descriptors', async () => {
  const report = await runSourceSync(await connection(), undefined, db, () => { throw new Error('provider_not_configured') })
  expect(report.outcome).toBe('failed'); expect(report.results.map(r => r.status)).toEqual(['retrying', 'skipped', 'skipped'])
  expect(report.results[0].message).toBe('provider_not_configured')
  expect(await db.integrationAttempt.count({ where: { job: { connectionId }, status: 'FAILED' } })).toBe(1)
})
it('manual retry leaves historical batch report intact and refuses RUNNING reset', async () => {
  const report = await runSourceSync(await connection(), undefined, db, () => createMockProvider({ products: [bad] }))
  const j = await retryJob(report.results[0].jobId!, db)
  await runJob(j!, { provider: createMockProvider({ products: [{ ...bad, name: 'Fixed' }] }) }, db)
  const history = (await db.syncRun.findUniqueOrThrow({ where: { id: report.runId } })).stats as unknown as SyncReport
  expect(history.outcome).toBe('failed')
  await db.integrationJob.update({ where: { id: j!.id }, data: { status: 'RUNNING' } })
  await expect(retryJob(j!.id, db)).rejects.toMatchObject({ code: 'job_running' })
})

it('legacy migration reclassifies only proven false successes and preserves a later successful retry', async () => {
  const mixed = await job(), allBad = await job(JOB_PRICES_IMPORT), recovered = await job(JOB_AVAILABILITY_IMPORT)
  for (const [row, stats] of [[mixed, { imported: 1, failed: 2 }], [allBad, { imported: 0, failed: 2 }], [recovered, { imported: 1, failed: 1 }]] as const) {
    await db.integrationJob.update({ where: { id: row.id }, data: { status: 'SUCCEEDED' } })
    await db.integrationAttempt.create({ data: { jobId: row.id, attempt: 1, status: 'SUCCEEDED', stats, startedAt: new Date(1) } })
  }
  await db.integrationAttempt.create({ data: { jobId: recovered.id, attempt: 2, status: 'SUCCEEDED', stats: { imported: 2, failed: 0 }, startedAt: new Date(2) } })
  const sql = await fs.readFile('prisma/migrations/20260920230100_reclassify_import_failures/migration.sql', 'utf8')
  for (const statement of sql.replace(/^--.*$/gm, '').split(';').filter(s => s.trim())) await db.$executeRawUnsafe(statement)
  expect((await db.integrationJob.findUniqueOrThrow({ where: { id: mixed.id } })).status).toBe('PARTIAL')
  expect((await db.integrationJob.findUniqueOrThrow({ where: { id: allBad.id } })).status).toBe('FAILED')
  expect((await db.integrationJob.findUniqueOrThrow({ where: { id: recovered.id } })).status).toBe('SUCCEEDED')
})
