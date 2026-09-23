/** Opt-in replay of the authorized R05 snapshot. No remote IO; test DB guard is mandatory.
 * AXIMA_R16_SOURCE_DIR points to originals + audit-onec-snapshot.py output in derived/.
 * AXIMA_R16_VOLUME=1 additionally probes the 17,680 mapped products (diagnostic subset).
 */
import { beforeEach, afterEach, afterAll, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import contract from '../fixtures/onec/r05-contract.json'
import { sha256, CHUNK_LIMIT } from '@/lib/integrations/onec/storage'
import { openExchangeSession, initializeSession, receiveChunk, finishFile, publishGeneration } from '@/lib/integrations/onec/ledger'
import { parseCatalog, parseOffers, type OnecOffer, type OnecRawProduct } from '@/lib/integrations/onec/commerceml'
import { parseExchangeMetadata } from '@/lib/integrations/onec/metadata'
import { enqueueSourceSync, refreshQueuedSyncRuns } from '@/lib/integrations/sync-queue'
import { recoverExpiredWork } from '@/lib/integrations/recovery'
import { importAvailability } from '@/lib/integrations/import-availability'
import { importPrices } from '@/lib/integrations/import-prices'
import { importCatalog } from '@/lib/integrations/import-catalog'
import { createOneCProvider } from '@/lib/integrations/onec/provider'
import { projectStoreAvailability } from '@/lib/pricing/availability'
import { runDueJobs } from '@/lib/integrations/jobs'
import { saveSourceMapping } from '@/lib/integrations/mappings'
import { listCatalog } from '@/lib/catalog/read'
import { fingerprint } from '@/lib/catalog/normalize'
import type { SyncReport } from '@/lib/integrations/import-result'

const source = process.env.AXIMA_R16_SOURCE_DIR
const replay = source ? it : it.skip
const volume = source && process.env.AXIMA_R16_VOLUME === '1' ? it : it.skip
const db = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] }), previousDir = process.env.ONEC_EXCHANGE_DIR
let observedQueries = 0
db.$on('query', () => { observedQueries++ })
let storeId: string | undefined, connectionId: string, actor: { id: string; email: string }, root: string
const evidence: Record<string, unknown> = { scope: 'isolated local test database; no server writes', volumeSubsetIsNotSourceCorrection: true }

beforeEach(async context => {
  if (!source || context.task.mode === 'skip') return
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'axima-r16-exchange-'))
  process.env.ONEC_EXCHANGE_DIR = root
  storeId = (await db.store.create({ data: { slug: `r16-${randomUUID()}`, name: 'R16 isolated replay' } })).id
  connectionId = (await db.integrationConnection.create({ data: { storeId, name: 'R16 test source', provider: 'ONE_C', enabled: true, sourceState: 'ACTIVE', environment: 'TEST' } })).id
  actor = await db.user.create({ data: { storeId, email: 'r16@test.local', name: 'R16', passwordHash: 'not-a-login', role: 'ADMIN' } })
  const book = await db.priceBook.create({ data: { storeId, code: 'default', name: 'R05 test', currency: 'RUB', isDefault: true } })
  await saveSourceMapping(storeId, connectionId, { entityType: 'priceType', externalId: contract.channels[0].priceTypeExternalId, entityId: book.id }, actor, db)
  for (const spec of contract.channels) {
    const location = await db.inventoryLocation.create({ data: { storeId, code: spec.inventoryLocationCode, name: spec.inventoryLocationCode } })
    await saveSourceMapping(storeId, connectionId, { entityType: 'location', externalId: spec.warehouseExternalId, entityId: location.id }, actor, db)
    await db.fulfillmentChannel.create({ data: { storeId, code: spec.code, name: spec.code, inventoryLocationId: location.id, priceBookId: book.id, paymentMethod: spec.paymentMethod as 'CASH' | 'BANK_TRANSFER' } })
  }
  // The other warehouses have explicit storage mappings but no sale channel.
  // Their raw values remain auditable and are never added to rs/nal.
  for (const [i, spec] of Array.from(contract.excludedWarehouses.entries())) {
    const location = await db.inventoryLocation.create({ data: { storeId, code: `unexposed-${i}`, name: 'No R05 sales channel' } })
    await saveSourceMapping(storeId, connectionId, { entityType: 'location', externalId: spec.externalId, entityId: location.id }, actor, db)
  }
})
afterEach(async () => {
  if (!storeId) return
  await db.providerSnapshot.deleteMany({ where: { storeId } })
  await db.inbox.deleteMany({ where: { storeId } })
  await db.integrationError.deleteMany({ where: { storeId } })
  await db.store.delete({ where: { id: storeId } }); storeId = undefined
})
afterAll(async () => {
  if (source) await fs.writeFile(path.join(source, 'derived', 'replay-r16-6-regressions.json'), JSON.stringify(evidence, null, 2))
  if (previousDir === undefined) delete process.env.ONEC_EXCHANGE_DIR; else process.env.ONEC_EXCHANGE_DIR = previousDir
  await db.$disconnect()
})
async function publish(folder: string, verifyOriginals = false) {
  const credential = { connectionId, user: 'r16', pass: 'isolated-test' }, secret = 'r16-test'
  const session = await openExchangeSession(storeId!, credential, secret, db)
  const authority = { storeId: storeId!, sessionId: session.id, credentials: [credential], secret }
  await initializeSession(authority, db)
  for (const file of contract.sourceFiles) {
    const bytes = await fs.readFile(path.join(folder, file.name))
    if (verifyOriginals) { expect(sha256(bytes)).toBe(file.sha256); expect(bytes.length).toBe(file.bytes) }
    for (let offset = 0; offset < bytes.length; offset += CHUNK_LIMIT) await receiveChunk(authority, file.name, bytes.subarray(offset, offset + CHUNK_LIMIT), db)
    await finishFile(authority, file.name, db)
  }
  return publishGeneration(storeId!, connectionId, [session.id], actor, db)
}
async function sync(generationId: string) {
  const connection = await db.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
  const queued = await enqueueSourceSync(connection, generationId, db)
  // One attempt makes diagnostic failures terminal; this is not a production policy change.
  await db.integrationJob.updateMany({ where: { syncRunId: queued.runId }, data: { maxAttempts: 1 } })
  const timings: Array<{ type: string; ms: number }> = [], executionErrors: string[] = []
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    try {
      const results = await runDueJobs({ storeId, limit: 1 }, db)
      if (results.length) timings.push({ type: results[0].type, ms: Math.round(performance.now() - started) })
    } catch (error) {
      executionErrors.push(error instanceof Error ? error.message : String(error))
      timings.push({ type: 'uncaught_runner_error', ms: Math.round(performance.now() - started) })
      await recoverExpiredWork(db, 100, storeId)
    }
    await refreshQueuedSyncRuns(db, storeId)
  }
  const report = (await db.syncRun.findUniqueOrThrow({ where: { id: queued.runId } })).stats as unknown as SyncReport
  return { report, timings, executionErrors }
}
async function state() {
  const variants = await db.productVariant.findMany({ where: { storeId }, select: { id: true, productId: true, sku: true }, orderBy: { id: 'asc' } })
  const prices = await db.priceEntry.findMany({ where: { variant: { storeId } }, select: { id: true, variantId: true, priceBookId: true, amount: true }, orderBy: { id: 'asc' } })
  const stocks = await db.stock.findMany({ where: { variant: { storeId } }, select: { id: true, variantId: true, locationId: true, available: true, sourceUpdatedAt: true }, orderBy: { id: 'asc' } })
  const projections = await db.availabilityProjection.findMany({ where: { variant: { storeId } }, select: { id: true, variantId: true, fulfillmentChannelId: true, availableQuantity: true, sourceUpdatedAt: true }, orderBy: { id: 'asc' } })
  return { counts: { variants: variants.length, prices: prices.length, stocks: stocks.length, projections: projections.length }, digest: fingerprint(JSON.parse(JSON.stringify({ variants, prices, stocks, projections }))) }
}

replay('R16.6 original catalog preserves duplicate articles and catalog tombstones exclude offers', async () => {
  const products: OnecRawProduct[] = []
  const xml = await fs.readFile(path.join(source!, 'import0_1.xml'), 'utf8')
  const offerXml = await fs.readFile(path.join(source!, 'offers0_1.xml'), 'utf8')
  parseCatalog(xml, row => products.push(row))
  expect(products).toHaveLength(18020)
  // All signed source quantities parse; catalog deletion wins within this generation.
  const originalOffers: OnecOffer[] = []
  parseOffers(offerXml, row => originalOffers.push(row))
  expect(originalOffers.flatMap(row => row.warehouses).filter(w => w.qty < 0)).toHaveLength(41)
  expect(new Set(products.map(p => p.externalId)).size).toBe(18020)
  expect(new Set(products.map(p => p.sku)).size).toBe(17680)
  const generation = await publish(source!, true)
  const result = await sync(generation.id)
  evidence.original = { ...result, catalogMetadata: parseExchangeMetadata(xml, 'catalog'), offersMetadata: parseExchangeMetadata(offerXml, 'offers'), state: await state(), catalogDeletedOffers: 447 }
  expect(result.report.results.map(r => r.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
  expect(result.report.results[1].stats?.catalogDeleted).toBe(447)
  expect(result.report.results[0].stats?.imported).toBe(17573)
  expect((await state()).counts).toEqual({ variants: 17573, prices: 17267, stocks: 87865, projections: 35146 })
  const byProduct = new Map((await db.productVariant.findMany({ where: { storeId } })).map(v => [v.productId, v]))
  const refs = await db.externalReference.findMany({ where: { connectionId, entityType: 'product' } })
  const byExternal = new Map(refs.map(r => [r.externalId, byProduct.get(r.entityId)!]))
  for (const raw of products) {
    if (raw.deleted) expect(byExternal.has(raw.externalId)).toBe(false)
    else expect(byExternal.get(raw.externalId)?.sourceSku).toBe(raw.sku)
  }
  const before = await state(), repeated = await sync(generation.id)
  expect(repeated.report.outcome).toBe('success')
  expect((await state()).digest).toBe(before.digest)
  evidence.original = { ...evidence.original as object, replay: repeated, unchanged: true, activeIdentities: byExternal.size, unknownTombstones: 447 }
}, 300_000)

replay('R16 five original control nodes match both warehouses/prices/projections and replay preserves IDs and values', async () => {
  const generation = await publish(path.join(source!, 'derived', 'controls'))
  const first = await sync(generation.id)
  evidence.controls = { first }
  expect(first.report.outcome).toBe('success')
  const before = await state()
  expect(before.counts).toEqual({ variants: 5, prices: 4, stocks: 25, projections: 10 })
  const checked = []
  for (const control of contract.controls) {
    const variant = await db.productVariant.findUniqueOrThrow({ where: { storeId_sku: { storeId: storeId!, sku: control.sku } }, include: { prices: true } })
    expect(variant.prices.map(p => p.amount.toFixed(2))).toEqual(control.expectedPrice ? [control.expectedPrice] : [])
    for (const spec of contract.channels) {
      const channel = await db.fulfillmentChannel.findUniqueOrThrow({ where: { storeId_code: { storeId: storeId!, code: spec.code } } })
      const stock = await db.stock.findUniqueOrThrow({ where: { variantId_locationId: { variantId: variant.id, locationId: channel.inventoryLocationId } } })
      const projection = await db.availabilityProjection.findUniqueOrThrow({ where: { variantId_fulfillmentChannelId: { variantId: variant.id, fulfillmentChannelId: channel.id } } })
      const expected = control.expectedAvailable[spec.code as 'rs' | 'nal']
      expect(stock.available.toString()).toBe(expected); expect(projection.availableQuantity.toString()).toBe(expected)
      expect(stock.sourceUpdatedAt).toBeNull(); expect(projection.sourceUpdatedAt).toBeNull()
      const catalog = await listCatalog({ storeId: storeId!, channelId: channel.id })
      expect(catalog.items.find(item => item.sku === control.sku)?.availability?.stale).toBe(true)
      checked.push({ sku: control.sku, channel: spec.code, quantity: expected, price: control.expectedPrice, stale: true })
    }
  }
  const second = await sync(generation.id), after = await state()
  evidence.controls = { first, second, checked, before, after, unchanged: before.digest === after.digest }
  expect(second.report.outcome).toBe('success'); expect(after).toEqual(before)
}, 120_000)

volume('R16.6 mapped diagnostic subset completes all streams and repeats without new IDs', async () => {
  const generation = await publish(path.join(source!, 'derived', 'mapped-diagnostic'))
  const first = await sync(generation.id), after = await state()
  evidence.volume = { first, after, disclaimer: 'Diagnostic subset only; full originals are verified separately.' }
  expect(first.report.outcome).toBe('success')
  const products: OnecRawProduct[] = [], rows: OnecOffer[] = []
  parseCatalog(await fs.readFile(path.join(source!, 'derived', 'mapped-diagnostic', 'import0_1.xml'), 'utf8'), row => products.push(row))
  parseOffers(await fs.readFile(path.join(source!, 'derived', 'mapped-diagnostic', 'offers0_1.xml'), 'utf8'), row => rows.push(row))
  const live = new Set(products.filter(p => !p.deleted).map(p => p.externalId))
  const prices = rows.filter(r => live.has(r.externalId)).flatMap(r => r.prices).filter(p => p.amount > 0).length
  expect(after.counts).toEqual({ variants: 17254, prices, stocks: 86270, projections: 34508 })
  const second = await sync(generation.id), repeated = await state()
  expect(second.report.outcome).toBe('success'); expect(repeated).toEqual(after)
  evidence.volume = { ...evidence.volume as object, second, repeated, unchanged: true }
}, 300_000)

const perf = source && process.env.AXIMA_R16_PERFORMANCE === '1' ? it : it.skip
perf('R16.1 real 17,680 catalog rows and 35,360 projections finish atomically and replay without new IDs', async () => {
  const generation = await publish(path.join(source!, 'derived', 'mapped-diagnostic'))
  const measure = async (work: () => Promise<unknown>) => {
    const queries = observedQueries, started = performance.now()
    const result = await work()
    return { result, ms: Math.round(performance.now() - started), observedClientQueries: observedQueries - queries, rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2), processPeakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) }
  }
  // Catalog tombstones are explicitly excluded from this same generation’s offers.
  const initial = await measure(() => sync(generation.id)), first = initial.result as Awaited<ReturnType<typeof sync>>
  evidence.performance = { initial }
  expect(first.report.results[0].status).toBe('succeeded')
  expect(first.report.results[0].stats?.imported).toBe(17254)
  expect((await state()).counts.variants).toBe(17254)
  expect(first.report.outcome).toBe('success')
  expect(first.executionErrors).toEqual([])
  // These 426 source tombstones correctly create nothing on an empty store.
  // Reconstruct their old canonical identities to test a historical reimport as well.
  const mapped: OnecRawProduct[] = []
  parseCatalog(await fs.readFile(path.join(source!, 'derived', 'mapped-diagnostic', 'import0_1.xml'), 'utf8'), p => mapped.push(p))
  const tombstones = mapped.filter(p => p.deleted).map(p => ({ productId: randomUUID(), variantId: randomUUID(), raw: p }))
  expect(tombstones).toHaveLength(426)
  await db.product.createMany({ data: tombstones.map(p => ({ id: p.productId, storeId: storeId!, canonicalName: p.raw.name, status: 'ACTIVE' as const })) })
  await db.productVariant.createMany({ data: tombstones.map(p => ({ id: p.variantId, productId: p.productId, storeId: storeId!, sku: p.raw.sku, status: 'ACTIVE' as const })) })
  await db.externalReference.createMany({ data: tombstones.map(p => ({ connectionId, entityType: 'product', externalId: p.raw.externalId, entityId: p.productId })) })
  const before = await state()
  const replayed = await measure(() => sync(generation.id)), second = replayed.result as Awaited<ReturnType<typeof sync>>
  expect(second.report.results[0].status).toBe('succeeded')
  expect((await state()).digest).toBe(before.digest)
  expect(second.executionErrors).toEqual([])
  expect(second.report.results[0].stats?.removed).toBe(426)
  expect(await db.productVariant.count({ where: { storeId, status: 'ARCHIVED' } })).toBe(426)
  // Projection benchmark uses exact raw values from the read-only source snapshot;
  // direct fixture seeding measures projection rebuilding independently of import.
  const details = JSON.parse(await fs.readFile(path.join(source!, 'database.json'), 'utf8')) as { products: Array<{ id: string; variants: Array<{ id: string }> }>; references: Array<{ externalId: string; entityId: string }>; stocks: Array<{ variantId: string; locationId: string; available: string; sourceUpdatedAt: string | null }> }
  const inventory = JSON.parse(await fs.readFile('docs/audits/evidence/remediation/r05-source-inventory.json', 'utf8')) as { references: Array<{ externalId: string; entityId: string }> }
  const productExternal = new Map(details.references.map(r => [r.entityId, r.externalId]))
  const oldVariantExternal = new Map(details.products.flatMap(p => p.variants.map(v => [v.id, productExternal.get(p.id)!] as const)))
  const newRefs = await db.externalReference.findMany({ where: { connectionId, entityType: 'product' } })
  const variants = await db.productVariant.findMany({ where: { storeId } })
  const byProduct = new Map(variants.map(v => [v.productId, v.id])), byExternal = new Map(newRefs.map(r => [r.externalId, byProduct.get(r.entityId)!]))
  const locations = await db.externalReference.findMany({ where: { connectionId, entityType: 'location' } })
  const oldLocationExternal = new Map(inventory.references.map(r => [r.entityId, r.externalId])), locationByExternal = new Map(locations.map(r => [r.externalId, r.entityId]))
  const stocks = details.stocks.map(s => ({ variantId: byExternal.get(oldVariantExternal.get(s.variantId)!)!, locationId: locationByExternal.get(oldLocationExternal.get(s.locationId)!)!, available: s.available, sourceUpdatedAt: s.sourceUpdatedAt }))
  await db.stock.deleteMany({ where: { variant: { storeId } } })
  for (let i = 0; i < stocks.length; i += 500) await db.stock.createMany({ data: stocks.slice(i, i + 500) })
  const projections = await measure(() => projectStoreAvailability(storeId!, db))
  const projected = await state()
  expect(projected.counts.projections).toBe(35360)
  const mismatch = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM "AvailabilityProjection" a
    JOIN "FulfillmentChannel" c ON c.id = a."fulfillmentChannelId"
    JOIN "Stock" s ON s."variantId" = a."variantId" AND s."locationId" = c."inventoryLocationId"
    WHERE c."storeId" = ${storeId} AND (a."availableQuantity" <> GREATEST(s.available, 0) OR a."sourceUpdatedAt" IS DISTINCT FROM s."sourceUpdatedAt")`
  expect(Number(mismatch[0].count)).toBe(0)
  const projectionReplay = await measure(() => projectStoreAvailability(storeId!, db))
  expect((await state()).digest).toBe(projected.digest)
  evidence.performance = { inputRows: 17680, activeRows: 17254, legacyTombstonesArchived: 426, initial, replayed, catalogIdentityStable: true, projections, projectionReplay, projectionValuesAndIdsStable: true, projectionCount: 35360, projectionFixture: 'Existing server raw stocks seeded directly; per-channel sale quantities clamp negatives to zero.' }
  expect(initial.ms).toBeLessThan(120_000); expect(replayed.ms).toBeLessThan(120_000); expect(projections.ms).toBeLessThan(120_000)
}, 300_000)

perf('R16.1 a clearly synthetic 18,020-row catalog stays within the same 120-second transaction limit', async () => {
  const folder = path.join(root, 'synthetic-input')
  await fs.mkdir(folder)
  const products = Array.from({ length: 18020 }, (_, i) => `<Товар><Ид>perf-${i}</Ид><Артикул>PERF-${i}</Артикул><Наименование>R16 synthetic ${i}</Наименование><Штрихкод>PERF-${i}</Штрихкод></Товар>`).join('')
  await fs.writeFile(path.join(folder, 'import0_1.xml'), `<КоммерческаяИнформация><Каталог СодержитТолькоИзменения="false"><Ид>perf</Ид><Товары>${products}</Товары></Каталог></КоммерческаяИнформация>`)
  await fs.writeFile(path.join(folder, 'offers0_1.xml'), '<КоммерческаяИнформация><ИзмененияПакетаПредложений><Ид>perf</Ид><Предложения/></ИзмененияПакетаПредложений></КоммерческаяИнформация>')
  const generation = await publish(folder), queryStart = observedQueries, started = performance.now()
  const result = await sync(generation.id), ms = Math.round(performance.now() - started)
  evidence.syntheticCapacity = { rows: 18020, result, ms, observedClientQueries: observedQueries - queryStart, processPeakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024), disclaimer: 'Synthetic unique identities for capacity only; this is not a correction of the real XML.' }
  expect(result.report.outcome).toBe('success'); expect(result.executionErrors).toEqual([])
  expect((await state()).counts.variants).toBe(18020); expect(ms).toBeLessThan(120_000)
}, 180_000)


const skuReplay = source && process.env.AXIMA_R16_SKUS === '1' ? it : it.skip
skuReplay('R16.3 all 340 previously missing IDs receive an explicit outcome while 17,680 legacy identities stay intact', async () => {
  const original = JSON.parse(await fs.readFile(path.join(source!, 'database.json'), 'utf8')) as {
    products: Array<{ id: string; canonicalName: string; variants: Array<{ id: string; sku: string; isDefault: boolean; status: 'ACTIVE' | 'ARCHIVED' }> }>
    references: Array<{ externalId: string; entityId: string; externalCode: string | null }>
  }
  const sourceRows: OnecRawProduct[] = []
  parseCatalog(await fs.readFile(path.join(source!, 'import0_1.xml'), 'utf8'), p => sourceRows.push(p))
  const oldIds = new Set(original.references.map(r => r.externalId)), missing = sourceRows.filter(p => !oldIds.has(p.externalId))
  expect(missing).toHaveLength(340); expect(missing.filter(p => p.deleted)).toHaveLength(21)
  const seedVariants = original.products.flatMap(p => p.variants.map(v => ({ ...v, productId: p.id, storeId: storeId! })))
  for (let i = 0; i < original.products.length; i += 500) await db.product.createMany({ data: original.products.slice(i, i + 500).map(p => ({ id: p.id, canonicalName: p.canonicalName, storeId: storeId! })) })
  for (let i = 0; i < seedVariants.length; i += 500) await db.productVariant.createMany({ data: seedVariants.slice(i, i + 500) })
  for (let i = 0; i < original.references.length; i += 500) await db.externalReference.createMany({ data: original.references.slice(i, i + 500).map(r => ({ ...r, connectionId, entityType: 'product' })) })
  const migration = await fs.readFile('prisma/migrations/20260921020000_source_product_codes/migration.sql', 'utf8')
  const backfillStarted = performance.now()
  await db.$executeRawUnsafe(migration.slice(migration.indexOf('UPDATE "ProductVariant"')))
  const backfillMs = Math.round(performance.now() - backfillStarted)
  const generation = await publish(source!, true), start = performance.now(), first = await sync(generation.id)
  expect(first.report.results[0]).toMatchObject({ status: 'succeeded', stats: { imported: 17573, removed: 426 } })
  // Unknown catalog tombstones are accounted for without creating identities.
  expect(first.report.outcome).toBe('success')
  const firstMs = Math.round(performance.now() - start)
  const variants = await db.productVariant.findMany({ where: { storeId } }), byId = new Map(variants.map(v => [v.id, v]))
  for (const old of seedVariants) expect(byId.get(old.id)).toMatchObject({ id: old.id, productId: old.productId, sku: old.sku })
  expect(variants).toHaveLength(17999)
  expect(variants.filter(v => v.status === 'ARCHIVED')).toHaveLength(426)
  const byProduct = new Map(variants.map(v => [v.productId, v]))
  const refs = await db.externalReference.findMany({ where: { connectionId, entityType: 'product' } })
  const byExternal = new Map(refs.map(r => [r.externalId, byProduct.get(r.entityId)!]))
  const outcomes = missing.map(raw => ({ externalId: raw.externalId, article: raw.sku, outcome: raw.deleted ? 'unknown_tombstone_no_creation' : 'created_distinct_identity', variantId: byExternal.get(raw.externalId)?.id ?? null, internalSku: byExternal.get(raw.externalId)?.sku ?? null }))
  for (const raw of missing) {
    if (raw.deleted) expect(byExternal.has(raw.externalId)).toBe(false)
    else expect(byExternal.get(raw.externalId)).toMatchObject({ sourceSku: raw.sku, status: 'ACTIVE' })
  }
  for (const raw of sourceRows.filter(p => !p.deleted)) expect(byExternal.get(raw.externalId)?.sourceSku).toBe(raw.sku)
  const before = await state(), replayStart = performance.now(), second = await sync(generation.id)
  const secondMs = Math.round(performance.now() - replayStart), after = await state()
  expect(second.report.results[0].status).toBe('succeeded'); expect(after.digest).toBe(before.digest)
  evidence.skuLegacyReplay = { backfillMs, firstMs, secondMs, originalVariants: seedVariants.length, preservedOriginalIdsAndSkus: true, missing: 340, created: 319, unknownTombstones: 21, active: 17573, archived: 426, total: 17999, before, after, first, second, outcomes }
}, 300_000)


const negativeReplay = source && process.env.AXIMA_R16_NEGATIVES === '1' ? it : it.skip
negativeReplay('R16.4 accounts for all 41 original negative stocks: 36 imported, 5 catalog-deleted source records retained', async () => {
  const xml = await fs.readFile(path.join(source!, 'import0_1.xml'), 'utf8')
  const offerXml = await fs.readFile(path.join(source!, 'offers0_1.xml'), 'utf8')
  for (const spec of contract.sourceFiles) expect(sha256(await fs.readFile(path.join(source!, spec.name)))).toBe(spec.sha256)
  const products: OnecRawProduct[] = [], allOffers: OnecOffer[] = []
  parseCatalog(xml, row => products.push(row)); parseOffers(offerXml, row => allOffers.push(row))
  const byId = new Map(products.map(p => [p.externalId, p]))
  const negativeOffers = allOffers.filter(o => o.warehouses.some(w => w.qty < 0))
  const live = negativeOffers.filter(o => !byId.get(o.externalId)!.deleted)
  const deleted = negativeOffers.filter(o => byId.get(o.externalId)!.deleted)
  expect(negativeOffers).toHaveLength(41); expect(live).toHaveLength(36); expect(deleted).toHaveLength(5)
  // Keep selected XML nodes byte-for-byte (including signs, metadata and tombstones).
  const subset = (body: string, tag: string, ids: Set<string>) => body.replace(new RegExp(`<${tag}(?=[\\s>])[^>]*>[\\s\\S]*?<\\/${tag}>`, 'g'), node => {
    const id = node.match(/<Ид>([^<]+)<\/Ид>/)?.[1]
    if (!id) throw new Error('diagnostic_node_missing_id')
    return ids.has(id) ? node : ''
  })
  const folder = path.join(root, 'negative-control'); await fs.mkdir(folder)
  const writeSubset = async (ids: Set<string>) => {
    await fs.writeFile(path.join(folder, 'import0_1.xml'), subset(xml, 'Товар', ids))
    await fs.writeFile(path.join(folder, 'offers0_1.xml'), subset(offerXml, 'Предложение', ids))
  }
  await writeSubset(new Set(live.map(o => o.externalId)))
  const generation = await publish(folder), first = await sync(generation.id)
  expect(first.report.outcome).toBe('success'); expect(first.executionErrors).toEqual([])
  const refs = await db.externalReference.findMany({ where: { connectionId, entityType: 'product' } })
  const vs = await db.productVariant.findMany({ where: { storeId } })
  const byProduct = new Map(vs.map(v => [v.productId, v.id])), byExternal = new Map(refs.map(r => [r.externalId, byProduct.get(r.entityId)!]))
  const locations = new Map((await db.externalReference.findMany({ where: { connectionId, entityType: 'location' } })).map(r => [r.externalId, r.entityId]))
  const books = new Map((await db.externalReference.findMany({ where: { connectionId, entityType: 'priceType' } })).map(r => [r.externalId, r.entityId]))
  const channels = await db.fulfillmentChannel.findMany({ where: { storeId } })
  const outcomes: Array<Record<string, unknown>> = []
  let checkedStocks = 0, checkedPrices = 0, checkedProjections = 0
  for (const raw of live) {
    const variantId = byExternal.get(raw.externalId)!
    for (const w of raw.warehouses) {
      const locationId = locations.get(w.id)!
      const stock = await db.stock.findUniqueOrThrow({ where: { variantId_locationId: { variantId, locationId } } })
      expect(stock.available.toNumber()).toBe(w.qty)
      expect(stock.sourceConnectionId).toBe(connectionId); expect(stock.sourceGenerationId).toBe(generation.id)
      expect(stock.sourceScopeKey).toBe(w.id); expect(stock.sourceUpdatedAt).toBeNull(); checkedStocks++
      for (const channel of channels.filter(c => c.inventoryLocationId === locationId)) {
        const projection = await db.availabilityProjection.findUniqueOrThrow({ where: { variantId_fulfillmentChannelId: { variantId, fulfillmentChannelId: channel.id } } })
        expect(projection.availableQuantity.toNumber()).toBe(Math.max(0, w.qty)); expect(projection.sourceUpdatedAt).toBeNull(); checkedProjections++
      }
      if (w.qty < 0) outcomes.push({ externalId: raw.externalId, warehouse: w.id, raw: w.qty, saleAvailable: 0, outcome: 'imported_signed_raw' })
    }
    for (const price of raw.prices) {
      const entry = await db.priceEntry.findUnique({ where: { priceBookId_variantId: { priceBookId: books.get(price.priceTypeId)!, variantId } } })
      if (price.amount === 0) expect(entry).toBeNull(); else expect(entry?.amount.toNumber()).toBe(price.amount)
      checkedPrices++
    }
  }
  const before = await state(), second = await sync(generation.id)
  expect(second.report.outcome).toBe('success'); expect(await state()).toEqual(before)
  // Explicit historical identities let the catalog archive all five, without resurrection.
  for (const raw of deleted) {
    const p = byId.get(raw.externalId)!
    const product = await db.product.create({ data: { storeId: storeId!, canonicalName: p.name } })
    await db.productVariant.create({ data: { storeId: storeId!, productId: product.id, sku: `historical-${raw.externalId}` } })
    await db.externalReference.create({ data: { connectionId, entityType: 'product', externalId: raw.externalId, entityId: product.id } })
  }
  await writeSubset(new Set(negativeOffers.map(o => o.externalId)))
  const conflictGeneration = await publish(folder)
  const input = { storeId: storeId!, connectionId, generationId: conflictGeneration.id, provider: createOneCProvider(connectionId, conflictGeneration.id) }
  await importCatalog(input, db)
  const conflictBefore = await state()
  expect(await importPrices(input, db)).toMatchObject({ imported: 36, failed: 0, skipped: 5, catalogDeleted: 5 })
  expect(await importAvailability(input, db)).toMatchObject({ imported: 180, failed: 0, skipped: 25, catalogDeleted: 5 })
  expect(await state()).toEqual(conflictBefore)
  expect(await db.productVariant.count({ where: { storeId, status: 'ARCHIVED' } })).toBe(5)
  for (const raw of deleted) {
    // Probe each unchanged original offer independently; none is silently omitted.
    const one = createOneCProvider(connectionId, conflictGeneration.id)
    const originalPull = one.pullAvailability!.bind(one)
    const rows: unknown[] = []
    let cursor: string | undefined
    do { const page = await originalPull(cursor); rows.push(...page.items); cursor = page.nextCursor } while (cursor)
    one.pullAvailability = async () => ({ items: rows.filter(row => (row as { externalId: string }).externalId === raw.externalId), mode: 'delta' })
    expect(await importAvailability({ ...input, provider: one }, db)).toMatchObject({ imported: 0, failed: 0, skipped: 5, catalogDeleted: 1 })
    for (const w of raw.warehouses.filter(w => w.qty < 0)) outcomes.push({ externalId: raw.externalId, warehouse: w.id, raw: w.qty, outcome: 'catalog_deleted_retained_source', retainedIn: 'immutable source XML', canonicalStockWritten: false })
  }
  expect(outcomes).toHaveLength(41)
  expect(await state()).toEqual(conflictBefore)
  await fs.writeFile(path.join(source!, 'derived', 'r16-6-negative-outcomes.json'), JSON.stringify(outcomes, null, 2))
  evidence.negatives = { originalNegatives: 41, importedNegatives: 36, catalogDeletedNegatives: 5, checkedStocks, checkedPrices, checkedProjections, first, second, replayUnchanged: true, catalogDeletionWins: true, sourceFiles: contract.sourceFiles, diagnosticSubsetNotSourceCorrection: true }
}, 180_000)
