/** Authorized local snapshot; test-db-guard applies. No remote access or production confirmation. */
import { afterAll, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { draftLegacyOwnership, applyLegacyOwnership } from '@/lib/integrations/onec/legacy-ownership'
import { openExchangeSession, initializeSession, receiveChunk, finishFile, publishGeneration } from '@/lib/integrations/onec/ledger'
import { CHUNK_LIMIT, sha256 } from '@/lib/integrations/onec/storage'
import { parseCatalog, parseOffers, type OnecRawProduct, type OnecOffer } from '@/lib/integrations/onec/commerceml'
import { enqueueSourceSync, refreshQueuedSyncRuns } from '@/lib/integrations/sync-queue'
import { runDueJobs } from '@/lib/integrations/jobs'
import { saveSourceChannel, saveSourceMapping } from '@/lib/integrations/mappings'
import { availabilityForVariants } from '@/lib/pricing/availability'
import { priceVariantsInContext } from '@/lib/pricing'
import { fingerprint } from '@/lib/catalog/normalize'
import type { SyncReport } from '@/lib/integrations/import-result'
import contract from '../fixtures/onec/r05-contract.json'
import inventory from '../../docs/audits/evidence/remediation/r05-source-inventory.json'

const source = process.env.AXIMA_R16_SOURCE_DIR
const replay = source && process.env.AXIMA_R16_FULL === '1' ? it : it.skip
const db = new PrismaClient(), previousDir = process.env.ONEC_EXCHANGE_DIR
const evidence: Record<string, unknown> = { scope: 'local only; original XML unchanged; no deployment', sourceFiles: contract.sourceFiles }
afterAll(async () => {
  if (source && process.env.AXIMA_R16_FULL === '1') await fs.writeFile(path.join(source, 'derived', 'r16-6-full-acceptance.json'), JSON.stringify(evidence, null, 2))
  if (previousDir === undefined) delete process.env.ONEC_EXCHANGE_DIR; else process.env.ONEC_EXCHANGE_DIR = previousDir
  await db.$disconnect()
})
replay.each(['empty', 'legacy'] as const)('R16.6 original complete exchange and repeat on %s store', async mode => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axima-r16-6-')); process.env.ONEC_EXCHANGE_DIR = root
  const original = JSON.parse(await fs.readFile(path.join(source!, 'database.json'), 'utf8')) as {
    products: Array<{ id: string; canonicalName: string; variants: Array<{ id: string; sku: string; isDefault: boolean; status: 'ACTIVE' | 'ARCHIVED' }> }>
    references: Array<{ externalId: string; entityId: string; externalCode: string | null }>
    prices: Array<{ variantId: string; priceBookId: string; amount: string }>
    stocks: Array<{ variantId: string; locationId: string; available: string; sourceUpdatedAt: string | null }>
  }
  const products: OnecRawProduct[] = [], offers: OnecOffer[] = []
  parseCatalog(await fs.readFile(path.join(source!, 'import0_1.xml'), 'utf8'), row => products.push(row))
  parseOffers(await fs.readFile(path.join(source!, 'offers0_1.xml'), 'utf8'), row => offers.push(row))
  expect(products).toHaveLength(18020); expect(offers).toHaveLength(18020)
  const deleted = new Set(products.filter(p => p.deleted).map(p => p.externalId))
  expect(deleted.size).toBe(447)
  const liveOffers = offers.filter(o => !deleted.has(o.externalId))
  expect(liveOffers).toHaveLength(17573)
  expect(liveOffers.flatMap(o => o.prices).filter(p => p.amount > 0)).toHaveLength(17267)
  const storeId = (await db.store.create({ data: { slug: `r16-6-${mode}-${randomUUID()}`, name: 'R16.6 local acceptance' } })).id
  const report: Record<string, unknown> = { mode, root }; evidence[mode] = report
  try {
    const connectionId = (await db.integrationConnection.create({ data: { storeId, name: 'R16.6 source', provider: 'ONE_C', enabled: true, sourceState: 'ACTIVE', environment: 'TEST' } })).id
    const admin = await db.user.create({ data: { storeId, email: 'acceptance@test.local', passwordHash: 'not-login', role: 'ADMIN', name: 'Test Admin' } })
    const oldVariants = mode === 'legacy' ? original.products.flatMap(p => p.variants.map(v => ({ ...v, storeId, productId: p.id }))) : []
    if (mode === 'legacy') {
      await db.priceBook.createMany({ data: inventory.books.map(b => ({ id: b.id, storeId, code: b.code, name: b.name, currency: b.currency, isDefault: b.isDefault })) })
      await db.inventoryLocation.createMany({ data: inventory.locations.map(l => ({ id: l.id, storeId, code: l.code, name: l.name })) })
      for (const c of inventory.channels) await db.fulfillmentChannel.create({ data: { id: c.id, storeId, code: c.code, name: c.name, inventoryLocationId: c.inventoryLocationId, priceBookId: c.priceBookId, paymentMethod: c.paymentMethod as 'CASH' | 'BANK_TRANSFER' } })
      await db.externalReference.createMany({ data: inventory.references.map(r => ({ ...r, connectionId })) })
      for (let i = 0; i < original.products.length; i += 500) await db.product.createMany({ data: original.products.slice(i, i + 500).map(p => ({ id: p.id, storeId, canonicalName: p.canonicalName })) })
      for (let i = 0; i < oldVariants.length; i += 500) await db.productVariant.createMany({ data: oldVariants.slice(i, i + 500) })
      for (let i = 0; i < original.references.length; i += 500) await db.externalReference.createMany({ data: original.references.slice(i, i + 500).map(r => ({ ...r, connectionId, entityType: 'product' })) })
      for (let i = 0; i < original.prices.length; i += 500) await db.priceEntry.createMany({ data: original.prices.slice(i, i + 500) })
      for (let i = 0; i < original.stocks.length; i += 500) await db.stock.createMany({ data: original.stocks.slice(i, i + 500) })
    } else {
      await db.priceBook.create({ data: { storeId, code: 'default', name: 'Default', currency: 'RUB', isDefault: true } })
      for (const spec of contract.channels) {
        const location = await db.inventoryLocation.create({ data: { storeId, code: spec.inventoryLocationCode, name: spec.inventoryLocationCode } })
        const book = await db.priceBook.findFirstOrThrow({ where: { storeId, code: 'default' } })
        await db.fulfillmentChannel.create({ data: { storeId, code: spec.code, name: spec.code, inventoryLocationId: location.id, priceBookId: book.id, paymentMethod: spec.paymentMethod as 'CASH' | 'BANK_TRANSFER' } })
        await saveSourceMapping(storeId, connectionId, { entityType: 'location', externalId: spec.warehouseExternalId, entityId: location.id }, admin, db)
      }
    }
    const oldPrices = await db.priceEntry.findMany({ where: { variant: { storeId } } })
    const oldStocks = await db.stock.findMany({ where: { variant: { storeId } } })
    const credential = { connectionId, user: 'test', pass: 'test' }, secret = 'test'
    const session = await openExchangeSession(storeId, credential, secret, db)
    const authority = { storeId, sessionId: session.id, credentials: [credential], secret }; await initializeSession(authority, db)
    for (const spec of contract.sourceFiles) {
      const bytes = await fs.readFile(path.join(source!, spec.name)); expect(sha256(bytes)).toBe(spec.sha256); expect(bytes.length).toBe(spec.bytes)
      for (let offset = 0; offset < bytes.length; offset += CHUNK_LIMIT) await receiveChunk(authority, spec.name, bytes.subarray(offset, offset + CHUNK_LIMIT), db)
      await finishFile(authority, spec.name, db)
    }
    const generation = await publishGeneration(storeId, connectionId, [session.id], admin, db)
    const book = await db.priceBook.findFirstOrThrow({ where: { storeId, code: 'default' } })
    if (mode === 'legacy') {
      const started = performance.now()
      const plan = await draftLegacyOwnership({ storeId, connectionId, generationId: generation.id, mappings: [{ entityType: 'priceType', externalId: contract.channels[0].priceTypeExternalId, entityId: book.id }] }, db)
      expect(plan.blockers).toEqual([]); expect(plan.decisions).toHaveLength(52731)
      const receipt = await applyLegacyOwnership(plan, plan.digest, admin.id, db)
      report.ownership = { rows: plan.decisions.length, digest: receipt.digest, ms: Math.round(performance.now() - started), catalogTombstoneRows: plan.decisions.filter(d => d.catalogDeleted).length }
      report.snapshotLimit = 'Original Product/Variant IDs and SKUs restored. Price/Stock IDs, reserved, effective dates and absent metadata generated in fixture; this digest is not approval for server apply.'
    } else await saveSourceMapping(storeId, connectionId, { entityType: 'priceType', externalId: contract.channels[0].priceTypeExternalId, entityId: book.id }, admin, db)
    for (const spec of contract.channels) {
      const channel = await db.fulfillmentChannel.findUniqueOrThrow({ where: { storeId_code: { storeId, code: spec.code } } })
      const seller = contract.sellers[spec.sellerKey as keyof typeof contract.sellers].requisites
      await saveSourceMapping(storeId, connectionId, { entityType: 'seller', externalId: spec.sellerKey, entityId: channel.id, seller }, admin, db)
      await saveSourceChannel(storeId, connectionId, { channelId: channel.id, warehouseExternalId: spec.warehouseExternalId, priceTypeExternalId: spec.priceTypeExternalId, sellerExternalId: spec.sellerKey }, admin, db)
    }
    for (const [i, spec] of Array.from(contract.excludedWarehouses.entries())) {
      const location = await db.inventoryLocation.create({ data: { storeId, code: `storage-${i}`, name: 'No sales channel' } })
      await saveSourceMapping(storeId, connectionId, { entityType: 'location', externalId: spec.externalId, entityId: location.id }, admin, db)
    }
    const run = async () => {
      const conn = await db.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
      const queued = await enqueueSourceSync(conn, generation.id, db)
      await db.integrationJob.updateMany({ where: { syncRunId: queued.runId }, data: { maxAttempts: 1 } })
      const timings = []
      for (let i = 0; i < 3; i++) {
        const started = performance.now(), results = await runDueJobs({ storeId, limit: 1 }, db)
        timings.push({ type: results[0]?.type, ms: Math.round(performance.now() - started), rssMiB: Math.round(process.memoryUsage().rss / 1024 ** 2) })
        await refreshQueuedSyncRuns(db, storeId)
      }
      return { report: (await db.syncRun.findUniqueOrThrow({ where: { id: queued.runId } })).stats as unknown as SyncReport, timings }
    }
    const first = await run(); report.first = first
    expect(first.report.results.map(r => r.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(first.report.outcome).toBe('success')
    expect(first.report.results[1].stats).toMatchObject({ imported: 17573, failed: 0, skipped: 447, catalogDeleted: 447, unknownDeleted: mode === 'legacy' ? 21 : 447 })
    expect(first.report.results[2].stats).toMatchObject({ imported: 87865, failed: 0, skipped: 2235, catalogDeleted: 447, unknownDeleted: mode === 'legacy' ? 21 : 447 })
    const readState = async () => {
      const variants = await db.productVariant.findMany({ where: { storeId }, orderBy: { id: 'asc' } })
      const prices = await db.priceEntry.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
      const stocks = await db.stock.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
      const projections = await db.availabilityProjection.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
      const digest = fingerprint(JSON.parse(JSON.stringify([variants, prices, stocks, projections].map(rows => rows.map(({ updatedAt: _at, ...r }) => r)))))
      return { variants, prices, stocks, projections, digest }
    }
    const before = await readState()
    expect(before.variants).toHaveLength(mode === 'legacy' ? 17999 : 17573)
    expect(before.variants.filter(v => v.status === 'ARCHIVED')).toHaveLength(mode === 'legacy' ? 426 : 0)
    expect(before.prices).toHaveLength(17267); expect(before.stocks).toHaveLength(87865); expect(before.projections).toHaveLength(35146)
    const byId = new Map(before.variants.map(v => [v.id, v])), byProduct = new Map(before.variants.map(v => [v.productId, v]))
    for (const old of oldVariants) expect(byId.get(old.id)).toMatchObject({ id: old.id, productId: old.productId, sku: old.sku })
    const refs = await db.externalReference.findMany({ where: { connectionId, entityType: 'product' } })
    const byExternal = new Map(refs.map(r => [r.externalId, byProduct.get(r.entityId)!]))
    const locations = new Map((await db.externalReference.findMany({ where: { connectionId, entityType: 'location' } })).map(r => [r.externalId, r.entityId]))
    const prices = new Map(before.prices.map(p => [p.variantId, p]))
    const stocks = new Map(before.stocks.map(s => [`${s.variantId}:${s.locationId}`, s]))
    const projections = new Map(before.projections.map(p => [`${p.variantId}:${p.fulfillmentChannelId}`, p]))
    const channels = await db.fulfillmentChannel.findMany({ where: { storeId } })
    const activeVariantIds = new Set(before.variants.filter(v => v.status === 'ACTIVE').map(v => v.id))
    for (const old of oldPrices.filter(p => activeVariantIds.has(p.variantId))) expect(prices.get(old.variantId)?.id).toBe(old.id)
    for (const old of oldStocks.filter(s => activeVariantIds.has(s.variantId))) expect(stocks.get(`${old.variantId}:${old.locationId}`)?.id).toBe(old.id)
    for (const raw of products) {
      const variant = byExternal.get(raw.externalId)
      if (!raw.deleted) expect(variant).toMatchObject({ status: 'ACTIVE', sourceSku: raw.sku })
      else if (variant) { expect(variant.status).toBe('ARCHIVED'); expect(prices.has(variant.id)).toBe(false) }
      else expect(mode === 'empty' || !original.references.some(r => r.externalId === raw.externalId)).toBe(true)
    }
    const negativeOutcomes: object[] = []
    for (const raw of offers) {
      const variant = byExternal.get(raw.externalId)
      if (deleted.has(raw.externalId)) {
        for (const wh of raw.warehouses) {
          if (variant) expect(stocks.has(`${variant.id}:${locations.get(wh.id)}`)).toBe(false)
          if (wh.qty < 0) negativeOutcomes.push({ externalId: raw.externalId, warehouse: wh.id, raw: wh.qty, outcome: 'catalog_deleted_retained_source' })
        }
        continue
      }
      const variantId = variant!.id
      for (const p of raw.prices) {
        if (p.amount === 0) expect(prices.has(variantId)).toBe(false)
        else {
          const saved = prices.get(variantId)!
          expect(saved.amount.toNumber()).toBe(p.amount)
          expect(saved).toMatchObject({ priceBookId: book.id, sourceConnectionId: connectionId, sourceGenerationId: generation.id, sourceScopeKey: p.priceTypeId })
          expect(p.currency).toBe(book.currency)
        }
      }
      for (const wh of raw.warehouses) {
        const locationId = locations.get(wh.id)!, saved = stocks.get(`${variantId}:${locationId}`)!
        expect(saved.available.toNumber()).toBe(wh.qty)
        expect(saved).toMatchObject({ sourceConnectionId: connectionId, sourceGenerationId: generation.id, sourceScopeKey: wh.id, sourceUpdatedAt: null })
        for (const channel of channels.filter(c => c.inventoryLocationId === locationId)) {
          const projected = projections.get(`${variantId}:${channel.id}`)!
          expect(projected.availableQuantity.toNumber()).toBe(Math.max(0, wh.qty)); expect(projected.sourceUpdatedAt).toBeNull()
        }
        if (wh.qty < 0) negativeOutcomes.push({ externalId: raw.externalId, warehouse: wh.id, raw: wh.qty, outcome: 'signed_raw_sale_zero' })
      }
    }
    expect(before.stocks.filter(s => s.available.isNegative())).toHaveLength(36); expect(negativeOutcomes).toHaveLength(41)
    const controls = []
    for (const control of contract.controls) {
      const variant = before.variants.find(v => v.sku === control.sku)!
      expect(prices.get(variant.id)?.amount.toFixed(2) ?? null).toBe(control.expectedPrice)
      for (const spec of contract.channels) {
        const channel = channels.find(c => c.code === spec.code)!
        const quantity = control.expectedAvailable[spec.code as 'rs' | 'nal']
        expect(stocks.get(`${variant.id}:${channel.inventoryLocationId}`)?.available.toString()).toBe(quantity)
        expect(projections.get(`${variant.id}:${channel.id}`)?.availableQuantity.toString()).toBe(quantity)
        const available = await availabilityForVariants({ variantIds: [variant.id], channelId: channel.id }, db)
        expect(available.get(variant.id)).toEqual({ available: Number(quantity), sourceUpdatedAt: null })
        const resolved = await priceVariantsInContext({ storeId, variantIds: [variant.id], channelId: channel.id })
        expect(resolved.get(variant.id)?.amount.toFixed(2) ?? null).toBe(control.expectedPrice)
        controls.push({ sku: control.sku, channel: spec.code, price: control.expectedPrice, quantity, stale: true })
      }
    }
    const second = await run(); report.second = second
    expect(second.report.outcome).toBe('success'); expect(second.report.results.map(r => r.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    const after = await readState(); expect(after.digest).toBe(before.digest)
    report.counts = { catalog: products.length, active: 17573, archived: mode === 'legacy' ? 426 : 0, unknownDeleted: mode === 'legacy' ? 21 : 447, prices: before.prices.length, stocks: before.stocks.length, projections: before.projections.length, negativeStocks: 36 }
    report.controls = controls; report.negativeOutcomes = negativeOutcomes
    report.catalogDeletedOutcomes = products.filter(p => p.deleted).map(p => ({ externalId: p.externalId, outcome: byExternal.has(p.externalId) ? 'archived_existing_identity' : 'unknown_tombstone_no_creation', ignoredPrices: offers.find(o => o.externalId === p.externalId)?.prices.length ?? 0, ignoredStocks: offers.find(o => o.externalId === p.externalId)?.warehouses.length ?? 0 }))
    report.beforeDigest = before.digest; report.afterDigest = after.digest
    report.allTuplesChecked = true; report.repeatPreservesIdsAndValues = true
    report.legacyPreserved = { productsAndVariants: oldVariants.length, activePriceIds: oldPrices.filter(p => activeVariantIds.has(p.variantId)).length, activeStockIds: oldStocks.filter(s => activeVariantIds.has(s.variantId)).length }
  } finally {
    await db.providerSnapshot.deleteMany({ where: { storeId } }); await db.inbox.deleteMany({ where: { storeId } }); await db.integrationError.deleteMany({ where: { storeId } })
    await db.store.delete({ where: { id: storeId } })
  }
}, 600_000)
