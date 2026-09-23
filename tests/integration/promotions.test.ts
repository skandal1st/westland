import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import { importCatalog } from '@/lib/integrations/import-catalog'
import { importPrices } from '@/lib/integrations/import-prices'
import { createPriceBook } from '@/lib/pricing/setup'
import { priceVariantsInContext } from '@/lib/pricing'
import { enqueueJob, runJob, retryJob, runDueJobs, JOB_CATALOG_IMPORT } from '@/lib/integrations/jobs'
import { getActiveBanners, invalidateContentCache } from '@/lib/content/read'

const prisma = new PrismaClient()
let storeId: string
let connectionId: string
let variantId: string
let brandId: string

const products = [{ externalId: 'PR1', sku: 'PR1', name: 'Promo Prod', packaging: '25 г' }]
const prices = [{ externalId: 'PR1', amount: 1000 }]

async function cleanup() {
  const store = await prisma.store.findUnique({ where: { slug: 'test-promo' } })
  if (store) {
    await prisma.inbox.deleteMany({ where: { storeId: store.id } })
    await prisma.integrationError.deleteMany({ where: { storeId: store.id } })
    await prisma.providerSnapshot.deleteMany({ where: { storeId: store.id } })
    await prisma.store.delete({ where: { id: store.id } })
  }
}

beforeAll(async () => {
  await cleanup()
  const store = await prisma.store.create({ data: { slug: 'test-promo', name: 'Test Promo' } })
  storeId = store.id
  await createPriceBook({ storeId, code: 'default', name: 'Base', isDefault: true }, prisma)

  const connection = await prisma.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'c' } })
  connectionId = connection.id
  const provider = createMockProvider({ products, prices })
  await importCatalog({ storeId, connectionId, provider }, prisma)
  await importPrices({ storeId, connectionId, provider }, prisma)

  const variant = await prisma.productVariant.findFirstOrThrow({ where: { storeId, sku: 'PR1' } })
  variantId = variant.id
  const brand = await prisma.brand.create({ data: { storeId, name: 'Promo Brand', slug: 'promo-brand' } })
  brandId = brand.id
  await prisma.product.update({ where: { id: variant.productId }, data: { brandId } })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('promotions in the pricing function (integration)', () => {
  it('leaves the price unchanged when promotions are disabled', async () => {
    const map = await priceVariantsInContext({ storeId, variantIds: [variantId] }, prisma)
    expect(map.get(variantId)?.amount).toBe(1000)
    expect(map.get(variantId)?.listAmount).toBeUndefined()
  })

  it('discounts the resolved price when an active promotion targets the brand', async () => {
    const promo = await prisma.promotion.create({
      data: { storeId, name: '20% brand', type: 'PERCENTAGE', value: 20, priority: 100, scope: { brandIds: [brandId] } },
    })
    const map = await priceVariantsInContext({ storeId, variantIds: [variantId], promotions: true }, prisma)
    expect(map.get(variantId)?.amount).toBe(800)
    expect(map.get(variantId)?.listAmount).toBe(1000)
    expect(map.get(variantId)?.promotionIds).toContain(promo.id)
    await prisma.promotion.delete({ where: { id: promo.id } })
  })

  it('does not apply a promotion scoped to a different brand', async () => {
    const promo = await prisma.promotion.create({
      data: { storeId, name: 'other', type: 'PERCENTAGE', value: 50, priority: 100, scope: { brandIds: ['nope'] } },
    })
    const map = await priceVariantsInContext({ storeId, variantIds: [variantId], promotions: true }, prisma)
    expect(map.get(variantId)?.amount).toBe(1000)
    await prisma.promotion.delete({ where: { id: promo.id } })
  })
})

describe('storefront banner read-model (integration)', () => {
  it('shows an active brand banner within its date window', async () => {
    await prisma.siteBanner.create({
      data: { storeId, name: 'Brand hero', placement: 'CATALOG', brandId, isActive: true, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86_400_000) },
    })
    invalidateContentCache(storeId)
    const banners = await getActiveBanners({ storeId, placement: 'CATALOG' }, prisma)
    expect(banners).toHaveLength(1)
    expect(banners[0].brand?.slug).toBe('promo-brand')
  })

  it('hides an expired banner', async () => {
    await prisma.siteBanner.deleteMany({ where: { storeId } })
    await prisma.siteBanner.create({
      data: { storeId, name: 'Old', placement: 'CATALOG', isActive: true, endsAt: new Date(Date.now() - 1000) },
    })
    invalidateContentCache(storeId)
    const banners = await getActiveBanners({ storeId, placement: 'CATALOG' }, prisma)
    expect(banners).toHaveLength(0)
  })
})

describe('integration job retry from backoffice (integration)', () => {
  it('makes a failed job visible and a manual retry drives it to SUCCESS', async () => {
    const conn = await prisma.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', enabled: true, sourceState: 'ACTIVE', environment: 'TEST', name: `retry-${Date.now()}` } })
    const failing = createMockProvider({ products: [{ externalId: 'RJ1', sku: 'RJ1', name: 'x', packaging: '1' }], pageSize: 1, failOnPage: 1 })
    const job = await enqueueJob({ storeId, connectionId: conn.id, type: JOB_CATALOG_IMPORT, maxAttempts: 1 }, prisma)

    const first = await runJob(job, { provider: failing }, prisma)
    expect(first.status).toBe('failed')
    const failed = await prisma.integrationJob.findUniqueOrThrow({ where: { id: job.id } })
    expect(failed.status).toBe('FAILED')
    expect(await prisma.integrationError.count({ where: { jobId: job.id } })).toBeGreaterThan(0)

    // Retry from backoffice with a now-healthy provider.
    await retryJob(job.id, prisma)
    const healthy = createMockProvider({ products: [{ externalId: 'RJ1', sku: 'RJ1', name: 'x', packaging: '1' }], pageSize: 1 })
    const results = await runDueJobs({ resolveProvider: () => healthy }, prisma)
    expect(results.find((r) => r.jobId === job.id)?.status).toBe('succeeded')
    expect((await prisma.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED')
  })

  it('retrying an already-succeeded job is idempotent (no re-run)', async () => {
    await prisma.integrationConnection.updateMany({ where: { storeId, sourceState: 'ACTIVE' }, data: { sourceState: 'RETIRED', enabled: false } })
    const conn = await prisma.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', enabled: true, sourceState: 'ACTIVE', environment: 'TEST', name: `idem-${Date.now()}` } })
    const provider = createMockProvider({ products: [{ externalId: 'ID1', sku: 'ID1', name: 'x', packaging: '1' }], pageSize: 1 })
    const job = await enqueueJob({ storeId, connectionId: conn.id, type: JOB_CATALOG_IMPORT }, prisma)
    await runJob(job, { provider }, prisma)
    const succeeded = await prisma.integrationJob.findUniqueOrThrow({ where: { id: job.id } })
    expect(succeeded.status).toBe('SUCCEEDED')

    const out = await retryJob(job.id, prisma)
    expect(out?.status).toBe('SUCCEEDED') // unchanged
    // Still due-free: nothing re-runs.
    const results = await runDueJobs({ resolveProvider: () => provider }, prisma)
    expect(results.find((r) => r.jobId === job.id)).toBeUndefined()
  })
})
