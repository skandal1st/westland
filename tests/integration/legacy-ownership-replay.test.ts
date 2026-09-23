/** Authorized local R16 snapshot only; never contacts the server. */
import { afterAll, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { draftLegacyOwnership, applyLegacyOwnership, rollbackLegacyOwnership } from '@/lib/integrations/onec/legacy-ownership'
import { openExchangeSession, initializeSession, receiveChunk, finishFile, publishGeneration } from '@/lib/integrations/onec/ledger'
import { CHUNK_LIMIT, sha256 } from '@/lib/integrations/onec/storage'
import { fingerprint } from '@/lib/catalog/normalize'
import contract from '../fixtures/onec/r05-contract.json'
import inventory from '../../docs/audits/evidence/remediation/r05-source-inventory.json'

const source = process.env.AXIMA_R16_SOURCE_DIR
const replay = source && process.env.AXIMA_R16_OWNERSHIP === '1' ? it : it.skip
const db = new PrismaClient(), previousDir = process.env.ONEC_EXCHANGE_DIR
afterAll(async () => { if (previousDir === undefined) delete process.env.ONEC_EXCHANGE_DIR; else process.env.ONEC_EXCHANGE_DIR = previousDir; await db.$disconnect() })
replay('R16.5 exact 52,731 legacy price/stock tuples can be reviewed, adopted and rolled back on the copy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'axima-r16-5-replay-')); process.env.ONEC_EXCHANGE_DIR = root
  const original = JSON.parse(await fs.readFile(path.join(source!, 'database.json'), 'utf8')) as {
    products: Array<{ id: string; canonicalName: string; variants: Array<{ id: string; sku: string; isDefault: boolean; status: 'ACTIVE' | 'ARCHIVED' }> }>
    references: Array<{ externalId: string; entityId: string; externalCode: string | null }>
    prices: Array<{ variantId: string; priceBookId: string; amount: string }>
    stocks: Array<{ variantId: string; locationId: string; available: string; sourceUpdatedAt: string | null }>
  }
  const storeId = (await db.store.create({ data: { slug: `r16-5-copy-${randomUUID()}`, name: 'R16.5 local snapshot copy' } })).id
  try {
    const connectionId = (await db.integrationConnection.create({ data: { storeId, name: 'R16.5 test source', provider: 'ONE_C', enabled: true, sourceState: 'ACTIVE', environment: 'TEST' } })).id
    const admin = await db.user.create({ data: { storeId, email: 'ownership@test.local', passwordHash: 'not-login', role: 'ADMIN', name: 'Test Admin' } })
    await db.priceBook.createMany({ data: inventory.books.map(b => ({ id: b.id, storeId, code: b.code, name: b.name, currency: b.currency, isDefault: b.isDefault })) })
    await db.inventoryLocation.createMany({ data: inventory.locations.map(l => ({ id: l.id, storeId, code: l.code, name: l.name })) })
    for (const c of inventory.channels) await db.fulfillmentChannel.create({ data: { id: c.id, storeId, code: c.code, name: c.name, inventoryLocationId: c.inventoryLocationId, priceBookId: c.priceBookId, paymentMethod: c.paymentMethod as 'CASH' | 'BANK_TRANSFER' } })
    await db.externalReference.createMany({ data: inventory.references.map(r => ({ ...r, connectionId })) })
    const variants = original.products.flatMap(p => p.variants.map(v => ({ ...v, storeId, productId: p.id })))
    for (let i = 0; i < original.products.length; i += 500) await db.product.createMany({ data: original.products.slice(i, i + 500).map(p => ({ id: p.id, storeId, canonicalName: p.canonicalName })) })
    for (let i = 0; i < variants.length; i += 500) await db.productVariant.createMany({ data: variants.slice(i, i + 500) })
    for (let i = 0; i < original.references.length; i += 500) await db.externalReference.createMany({ data: original.references.slice(i, i + 500).map(r => ({ ...r, connectionId, entityType: 'product' })) })
    for (let i = 0; i < original.prices.length; i += 500) await db.priceEntry.createMany({ data: original.prices.slice(i, i + 500) })
    for (let i = 0; i < original.stocks.length; i += 500) await db.stock.createMany({ data: original.stocks.slice(i, i + 500) })
    const credential = { connectionId, user: 'test', pass: 'test' }, secret = 'test'
    const session = await openExchangeSession(storeId, credential, secret, db)
    const authority = { storeId, sessionId: session.id, credentials: [credential], secret }; await initializeSession(authority, db)
    for (const spec of contract.sourceFiles) {
      const bytes = await fs.readFile(path.join(source!, spec.name)); expect(sha256(bytes)).toBe(spec.sha256)
      for (let offset = 0; offset < bytes.length; offset += CHUNK_LIMIT) await receiveChunk(authority, spec.name, bytes.subarray(offset, offset + CHUNK_LIMIT), db)
      await finishFile(authority, spec.name, db)
    }
    const generation = await publishGeneration(storeId, connectionId, [session.id], admin, db)
    const state = async () => {
      const prices = await db.priceEntry.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
      const stocks = await db.stock.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
      const channels = await db.fulfillmentChannel.findMany({ where: { storeId }, orderBy: { id: 'asc' } })
      const refs = await db.externalReference.findMany({ where: { connectionId }, orderBy: { id: 'asc' } })
      return fingerprint(JSON.parse(JSON.stringify({ prices, stocks, channels, refs })))
    }
    const before = await state(), started = performance.now()
    const plan = await draftLegacyOwnership({ storeId, connectionId, generationId: generation.id, mappings: [{ entityType: 'priceType', externalId: contract.channels[0].priceTypeExternalId, entityId: inventory.books[0].id }] }, db)
    const draftMs = Math.round(performance.now() - started)
    expect(plan.blockers).toEqual([]); expect(plan.decisions).toHaveLength(52731)
    expect(plan.before.rows.filter(r => r.kind === 'price')).toHaveLength(17371)
    expect(plan.before.rows.filter(r => r.kind === 'stock')).toHaveLength(35360)
    expect(plan.warnings).toContain('channel_warehouse_unmapped:rs'); expect(plan.warnings).toContain('channel_warehouse_unmapped:nal')
    expect(await state()).toBe(before)
    const planPath = path.join(source!, 'derived', 'r16-5-copy-plan.json')
    await fs.writeFile(planPath, JSON.stringify(plan))
    const applyAt = performance.now(), receipt = await applyLegacyOwnership(plan, plan.digest, admin.id, db), applyMs = Math.round(performance.now() - applyAt)
    expect(await db.priceEntry.count({ where: { variant: { storeId }, sourceConnectionId: connectionId } })).toBe(17371)
    expect(await db.stock.count({ where: { variant: { storeId }, sourceConnectionId: connectionId } })).toBe(35360)
    expect(await applyLegacyOwnership(plan, plan.digest, admin.id, db)).toEqual(receipt)
    const rollbackAt = performance.now()
    await rollbackLegacyOwnership(receipt.id, receipt.digest, admin.id, db)
    const rollbackMs = Math.round(performance.now() - rollbackAt)
    expect(await state()).toBe(before)
    const report = {
      scope: 'isolated snapshot copy, not a production confirmation', missingSnapshotFields: ['PriceEntry.id', 'Stock.id', 'xmin', 'reserved', 'effectiveFrom', 'effectiveTo', 'updatedAt'],
      syntheticFields: 'price/stock row IDs and absent defaults generated only in the fixture',
      sourceFiles: contract.sourceFiles, prices: 17371, stocks: 35360, decisions: plan.decisions.length,
      catalogTombstoneRows: plan.decisions.filter(d => d.catalogDeleted).length,
      negativeRawRows: plan.before.rows.filter(r => r.kind === 'stock' && Number(r.before.available) < 0).length,
      warnings: plan.warnings, newMappings: plan.createMappings.length, draftMs, applyMs, rollbackMs,
      beforeDigest: before, afterRollbackDigest: await state(), planDigest: plan.digest, planFileSha256: sha256(await fs.readFile(planPath)),
      repeatedApplySameReceipt: true, businessDataAndMappingsRestored: true, productAndVariantIdsPreserved: true,
      sourceOfCandidateData: 'authorized R16 database.json, source XML and R05 inventory; no server reads or writes',
    }
    await fs.writeFile(path.join(source!, 'derived', 'r16-5-copy-summary.json'), JSON.stringify(report, null, 2))
  } finally { await db.store.delete({ where: { id: storeId } }) }
}, 300_000)
