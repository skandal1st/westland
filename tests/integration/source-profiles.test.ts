import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { resolveActiveSource, requireActiveSource, publicSource } from '@/lib/integrations/sources'
import { enqueueJob, retryJob, runJob, runDueJobs, JOB_CATALOG_IMPORT } from '@/lib/integrations/jobs'
import { createMockProvider } from '@/lib/integrations/mock-provider'

const db = new PrismaClient()
afterAll(() => db.$disconnect())
let storeId: string
beforeEach(async () => { storeId = (await db.store.create({ data: { slug: `source-${randomUUID()}`, name: 'Source fixture' } })).id })
afterEach(async () => {
  await db.integrationError.deleteMany({ where: { storeId } })
  await db.store.delete({ where: { id: storeId } })
})
const create = (name: string, active = false) => db.integrationConnection.create({ data: {
  storeId, name, provider: 'ONE_C', enabled: active, sourceState: active ? 'ACTIVE' : 'PREPARING', environment: 'TEST',
} })

describe('explicit source authority', () => {
  it('never falls back to a disabled/preparing connection, even if enabled is true', async () => {
    const first = await create('first')
    await db.integrationConnection.update({ where: { id: first.id }, data: { enabled: true } })
    await create('second')
    expect(await resolveActiveSource(storeId, undefined, db)).toBeNull()
    await expect(requireActiveSource(first.id, storeId, db)).rejects.toMatchObject({ code: 'source_not_active' })
  })
  it('uses the same explicit source independently of row order and requested provider', async () => {
    await create('A preparing')
    const active = await create('Z active', true)
    expect((await resolveActiveSource(storeId, 'ONE_C', db))?.id).toBe(active.id)
    expect(await resolveActiveSource(storeId, 'CUSTOM', db)).toBeNull()
    await expect(requireActiveSource(active.id, 'another-store', db)).rejects.toMatchObject({ code: 'source_not_active' })
  })
  it('rejects two concurrent activations at the database boundary', async () => {
    const a = await create('a'), b = await create('b')
    const results = await Promise.allSettled([a, b].map(c => db.integrationConnection.update({ where: { id: c.id }, data: { enabled: true, sourceState: 'ACTIVE' } })))
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect(await db.integrationConnection.count({ where: { storeId, sourceState: 'ACTIVE' } })).toBe(1)
    await expect(db.integrationConnection.updateMany({ where: { storeId, sourceState: 'ACTIVE' }, data: { enabled: false } })).rejects.toThrow()
  })
  it('does not serialize arbitrary config or credential fields', async () => {
    const source = await create('private')
    const output = publicSource({ ...source, config: { password: 'private-sentinel', fixtures: [{ secret: 'private-sentinel' }] } })
    expect(JSON.stringify(output)).not.toContain('private-sentinel')
    expect(output).not.toHaveProperty('config')
    expect(output.canSync).toBe(false)
  })
  it('blocks enqueue/retry/direct execution and skips prepared jobs before constructing providers', async () => {
    const source = await create('prepared')
    await expect(enqueueJob({ storeId, connectionId: source.id, type: JOB_CATALOG_IMPORT }, db)).rejects.toMatchObject({ code: 'source_not_active' })
    const job = await db.integrationJob.create({ data: { storeId, connectionId: source.id, type: JOB_CATALOG_IMPORT, idempotencyKey: randomUUID() } })
    await expect(retryJob(job.id, db)).rejects.toMatchObject({ code: 'source_not_active' })
    await expect(runJob(job, { provider: createMockProvider({ products: [] }) }, db)).rejects.toMatchObject({ code: 'source_not_active' })
    const resolveProvider = vi.fn(() => createMockProvider({ products: [] }))
    await runDueJobs({ resolveProvider }, db)
    expect(resolveProvider).not.toHaveBeenCalled()
    expect((await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).attempts).toBe(0)
  })
})

it('migration preserves IDs/config and selects only the sole enabled legacy source', async () => {
  const schema = `r05_${randomUUID().replaceAll('-', '')}`
  const sql = fs.readFileSync(path.join(process.cwd(), 'prisma/migrations/20260920160000_integration_source_profiles/migration.sql'), 'utf8')
  // An isolated temporary schema exercises the actual migration against pre-migration rows.
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`)
    await tx.$executeRawUnsafe('CREATE TABLE "IntegrationConnection" ("id" text PRIMARY KEY, "storeId" text NOT NULL, "enabled" boolean NOT NULL, "config" jsonb)')
    await tx.$executeRawUnsafe(`INSERT INTO "IntegrationConnection" VALUES
      ('one', 'single', true, '{"brandGroups":["keep"]}'), ('disabled', 'single', false, '{}'),
      ('multi-a', 'multi', true, '{}'), ('multi-b', 'multi', true, '{}'), ('none', 'none', false, '{}')`)
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await tx.$executeRawUnsafe(statement)
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; environment: string; sourceState: string; config: unknown }>>('SELECT "id", "environment", "sourceState", "config" FROM "IntegrationConnection" ORDER BY "id"')
    expect(rows.filter(r => r.sourceState === 'ACTIVE').map(r => r.id)).toEqual(['one'])
    expect(rows.every(r => r.environment === 'UNCLASSIFIED')).toBe(true)
    expect(rows.find(r => r.id === 'one')?.config).toEqual({ brandGroups: ['keep'] })
    expect(rows).toHaveLength(5)
    await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`)
  }, { timeout: 20_000 })
})
