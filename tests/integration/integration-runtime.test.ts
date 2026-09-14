import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import { importCatalog } from '@/lib/integrations/import-catalog'
import { enqueueJob, runJob, runDueJobs, JOB_CATALOG_IMPORT } from '@/lib/integrations/jobs'
import { listCatalog } from '@/lib/catalog/read'

const prisma = new PrismaClient()
let storeId: string
let slug: string

const fixtures = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ externalId: `${prefix}-${i + 1}`, sku: `${prefix}-${i + 1}`, name: `${prefix} товар ${i + 1}`, packaging: '25 г' }))

async function connection(config?: Record<string, unknown>) {
  return prisma.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: `c-${Math.random().toString(36).slice(2, 8)}`, config: (config ?? undefined) as any } })
}

beforeEach(async () => {
  slug = `test-int-${Math.random().toString(36).slice(2, 8)}`
  const store = await prisma.store.create({ data: { slug, name: 'Test Integration' } })
  storeId = store.id
})

afterEach(async () => {
  await prisma.inbox.deleteMany({ where: { storeId } })
  await prisma.integrationError.deleteMany({ where: { storeId } })
  await prisma.providerSnapshot.deleteMany({ where: { storeId } })
  await prisma.store.delete({ where: { id: storeId } })
})

describe('integration runtime (integration)', () => {
  it('imports the full catalog and marks the checkpoint complete', async () => {
    const conn = await connection()
    const provider = createMockProvider({ products: fixtures('A', 3), pageSize: 2 })
    const stats = await importCatalog({ storeId, connectionId: conn.id, provider }, prisma)
    expect(stats.imported).toBe(3)
    expect((await listCatalog({ storeId })).total).toBe(3)
    const cp = await prisma.syncCheckpoint.findUnique({ where: { connectionId_entityType: { connectionId: conn.id, entityType: 'product' } } })
    expect(cp?.completed).toBe(true)
  })

  it('is idempotent on re-run (unchanged items are skipped, no duplicates)', async () => {
    const conn = await connection()
    const provider = createMockProvider({ products: fixtures('B', 3), pageSize: 2 })
    await importCatalog({ storeId, connectionId: conn.id, provider }, prisma)
    const second = await importCatalog({ storeId, connectionId: conn.id, provider }, prisma)
    expect(second.imported).toBe(0)
    expect(second.skipped).toBe(3)
    expect((await listCatalog({ storeId })).total).toBe(3)
  })

  it('resumes from checkpoint after a provider outage — no lost progress, no duplicates', async () => {
    const conn = await connection()
    const products = fixtures('C', 3)
    // Fails when fetching page 2; page 1 is committed to the checkpoint.
    await expect(
      importCatalog({ storeId, connectionId: conn.id, provider: createMockProvider({ products, pageSize: 1, failOnPage: 2 }) }, prisma),
    ).rejects.toThrow()
    const mid = await prisma.syncCheckpoint.findUnique({ where: { connectionId_entityType: { connectionId: conn.id, entityType: 'product' } } })
    expect(mid?.completed).toBe(false)
    expect(mid?.processed).toBe(1)

    // Resume with a healthy provider — continues from the checkpoint cursor.
    const resumed = await importCatalog({ storeId, connectionId: conn.id, provider: createMockProvider({ products, pageSize: 1 }) }, prisma)
    expect(resumed.imported).toBe(2)
    expect((await listCatalog({ storeId })).total).toBe(3)
  })

  it('bounds retries and persists errors; the storefront stays alive', async () => {
    const conn = await connection()
    const failing = createMockProvider({ products: fixtures('D', 2), pageSize: 1, failOnPage: 1 })
    const job = await enqueueJob({ storeId, connectionId: conn.id, type: JOB_CATALOG_IMPORT, maxAttempts: 2 }, prisma)

    const first = await runJob(job, { provider: failing }, prisma)
    expect(first.status).toBe('retrying')
    const reloaded = await prisma.integrationJob.findUnique({ where: { id: job.id } })
    const second = await runJob(reloaded!, { provider: failing }, prisma)
    expect(second.status).toBe('failed')

    const finalJob = await prisma.integrationJob.findUnique({ where: { id: job.id }, include: { attemptsLog: true } })
    expect(finalJob?.status).toBe('FAILED')
    expect(finalJob?.attempts).toBe(2)
    expect(finalJob?.attemptsLog).toHaveLength(2)
    expect(await prisma.integrationError.count({ where: { storeId, jobId: job.id } })).toBe(2)
    // Provider outage did not take down the catalog read path.
    await expect(listCatalog({ storeId })).resolves.toEqual({ items: [], total: 0 })
  })

  it('runs due jobs through the registry and imports via the mock provider', async () => {
    const conn = await connection({ fixtures: fixtures('E', 2), pageSize: 2 })
    await enqueueJob({ storeId, connectionId: conn.id, type: JOB_CATALOG_IMPORT }, prisma)
    const results = await runDueJobs({}, prisma)
    expect(results[0].status).toBe('succeeded')
    expect((await listCatalog({ storeId })).total).toBe(2)
  })

  it('deduplicates concurrent enqueue of the same connection/type', async () => {
    const conn = await connection()
    const a = await enqueueJob({ storeId, connectionId: conn.id, type: JOB_CATALOG_IMPORT }, prisma)
    const b = await enqueueJob({ storeId, connectionId: conn.id, type: JOB_CATALOG_IMPORT }, prisma)
    expect(b.id).toBe(a.id)
  })
})
