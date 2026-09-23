import { beforeEach, afterEach, afterAll, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openExchangeSession, initializeSession, receiveChunk, finishFile, publishGeneration } from '@/lib/integrations/onec/ledger'
import { draftLegacyOwnership, applyLegacyOwnership, rollbackLegacyOwnership } from '@/lib/integrations/onec/legacy-ownership'
import { fingerprint } from '@/lib/catalog/normalize'

const db = new PrismaClient(), previousDir = process.env.ONEC_EXCHANGE_DIR
let storeId: string, connectionId: string, generationId: string, adminId: string, bookId: string, locationId: string, otherLocationId: string
let variants: string[], prices: string[], stocks: string[], root: string
const req = () => ({ storeId, connectionId, generationId, mappings: [{ entityType: 'priceType', externalId: 'PT', entityId: bookId }] })
const state = async () => ({
  prices: await db.priceEntry.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } }),
  stocks: await db.stock.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } }),
  mappings: await db.externalReference.findMany({ where: { connectionId }, orderBy: { id: 'asc' } }),
  channels: await db.fulfillmentChannel.findMany({ where: { storeId } }),
  projections: await db.availabilityProjection.findMany({ where: { variant: { storeId } } }),
})
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'r16-5-'))
  process.env.ONEC_EXCHANGE_DIR = root
  storeId = (await db.store.create({ data: { slug: `r16-5-${randomUUID()}`, name: 'Ownership fixture' } })).id
  connectionId = (await db.integrationConnection.create({ data: { storeId, name: '1C', provider: 'ONE_C', sourceState: 'ACTIVE', enabled: true, environment: 'TEST' } })).id
  adminId = (await db.user.create({ data: { storeId, role: 'ADMIN', status: 'ACTIVE', email: 'admin@fixture.local', name: 'Admin', passwordHash: 'not-login' } })).id
  bookId = (await db.priceBook.create({ data: { storeId, code: 'default', name: 'Default' } })).id
  locationId = (await db.inventoryLocation.create({ data: { storeId, code: 'opt', name: 'Main' } })).id
  otherLocationId = (await db.inventoryLocation.create({ data: { storeId, code: 'west', name: 'Other' } })).id
  await db.externalReference.createMany({ data: [{ connectionId, entityType: 'location', externalId: 'WH', entityId: locationId }, { connectionId, entityType: 'location', externalId: 'WH2', entityId: otherLocationId }] })
  variants = []; prices = []; stocks = []
  for (let i = 1; i <= 2; i++) {
    const p = await db.product.create({ data: { storeId, canonicalName: `P${i}` } })
    const v = await db.productVariant.create({ data: { storeId, productId: p.id, sku: `P${i}` } }); variants.push(v.id)
    await db.externalReference.create({ data: { connectionId, entityType: 'product', externalId: `P${i}`, entityId: p.id } })
    prices.push((await db.priceEntry.create({ data: { variantId: v.id, priceBookId: bookId, amount: 12, effectiveFrom: new Date('2026-01-01Z') } })).id)
    stocks.push((await db.stock.create({ data: { variantId: v.id, locationId, available: -1.2, reserved: 2, sourceUpdatedAt: new Date('2026-01-01Z') } })).id)
  }
  await db.fulfillmentChannel.create({ data: { storeId, code: 'rs', name: 'RS', inventoryLocationId: locationId, priceBookId: bookId, paymentMethod: 'BANK_TRANSFER' } })
  const credential = { connectionId, user: 'test', pass: 'test' }, secret = 'test'
  const session = await openExchangeSession(storeId, credential, secret, db)
  const authority = { storeId, sessionId: session.id, credentials: [credential], secret }; await initializeSession(authority, db)
  const catalog = `<КоммерческаяИнформация><Каталог><Товары>${[1, 2].map(i => `<Товар${i === 2 ? ' Статус="Удален"' : ''}><Ид>P${i}</Ид><Артикул>P${i}</Артикул><Наименование>P${i}</Наименование></Товар>`).join('')}</Товары></Каталог></КоммерческаяИнформация>`
  const offers = `<КоммерческаяИнформация><ПакетПредложений><Предложения>${[1, 2].map(i => `<Предложение><Ид>P${i}</Ид><Цены><Цена><ИдТипаЦены>PT</ИдТипаЦены><ЦенаЗаЕдиницу>12</ЦенаЗаЕдиницу><Валюта>RUB</Валюта></Цена></Цены><Склады ИдСклада="WH" КоличествоНаСкладе="-1.2"/><Склады ИдСклада="WH2" КоличествоНаСкладе="7"/></Предложение>`).join('')}</Предложения></ПакетПредложений></КоммерческаяИнформация>`
  for (const [name, xml] of [['import.xml', catalog], ['offers.xml', offers]]) { await receiveChunk(authority, name, Buffer.from(xml), db); await finishFile(authority, name, db) }
  generationId = (await publishGeneration(storeId, connectionId, [session.id], { id: adminId, email: 'admin@fixture.local' }, db)).id
})
afterEach(async () => { await db.store.delete({ where: { id: storeId } }) })
afterAll(async () => { if (previousDir === undefined) delete process.env.ONEC_EXCHANGE_DIR; else process.env.ONEC_EXCHANGE_DIR = previousDir; await db.$disconnect() })

it('dry-run is read-only and enumerates exact values, source, tombstones, mappings and stable digest', async () => {
  const before = await state(), plan = await draftLegacyOwnership(req(), db)
  expect(plan.blockers).toEqual([]); expect(plan.decisions).toHaveLength(4)
  expect(plan.before.rows.find(r => r.id === stocks[0])?.before).toMatchObject({ available: '-1.2', reserved: '2', sourceConnectionId: null })
  expect(plan.before.rows.every(r => /^\d+$/.test(r.version))).toBe(true)
  expect(plan.decisions.filter(r => r.catalogDeleted)).toHaveLength(2)
  expect(plan.createMappings).toHaveLength(1); expect(plan.before.context.channels[0].code).toBe('rs')
  expect((await draftLegacyOwnership(req(), db)).digest).toBe(plan.digest)
  expect(await state()).toEqual(before)
})
it('apply, durable receipt, duplicate apply and rollback preserve business data and exact warehouse bindings', async () => {
  const before = await state(), plan = await draftLegacyOwnership(req(), db)
  const [a, b] = await Promise.all([applyLegacyOwnership(plan, plan.digest, adminId, db), applyLegacyOwnership(plan, plan.digest, adminId, db)])
  expect(a).toEqual(b); expect(a.status).toBe('APPLIED')
  expect(await db.legacyOwnershipBatch.count({ where: { storeId } })).toBe(1)
  const owned = await state()
  expect(owned.prices.every(r => r.sourceConnectionId === connectionId && r.sourceGenerationId === generationId && r.sourceScopeKey === 'PT')).toBe(true)
  expect(owned.stocks.every(r => r.sourceScopeKey === 'WH' && r.available.toString() === '-1.2' && r.reserved.toString() === '2')).toBe(true)
  expect(owned.channels).toEqual(before.channels); expect(owned.projections).toEqual(before.projections)
  expect((await rollbackLegacyOwnership(a.id, a.digest, adminId, db)).status).toBe('ROLLED_BACK')
  expect(await state()).toEqual(before)
  expect((await rollbackLegacyOwnership(a.id, a.digest, adminId, db)).status).toBe('ROLLED_BACK')
  await expect(applyLegacyOwnership(plan, plan.digest, adminId, db)).rejects.toMatchObject({ code: 'ownership_plan_already_rolled_back' })
  expect((await draftLegacyOwnership(req(), db)).digest).not.toBe(plan.digest)
  expect(await db.auditEntry.count({ where: { storeId, action: { in: ['LegacyOwnershipApplied', 'LegacyOwnershipRolledBack'] } } })).toBe(2)
})
it('wrong confirmation and edited or recomputed plans cannot assign ownership', async () => {
  const plan = await draftLegacyOwnership(req(), db), before = await state()
  await expect(applyLegacyOwnership(plan, 'wrong', adminId, db)).rejects.toMatchObject({ code: 'ownership_digest_mismatch' })
  const edited = JSON.parse(JSON.stringify(plan)); edited.decisions[0].scopeKey = 'foreign'
  await expect(applyLegacyOwnership(edited, plan.digest, adminId, db)).rejects.toMatchObject({ code: 'ownership_digest_mismatch' })
  const { digest: _digest, ...body } = edited; edited.digest = fingerprint(body)
  await expect(applyLegacyOwnership(edited, edited.digest, adminId, db)).rejects.toMatchObject({ code: 'ownership_plan_stale' })
  expect(await state()).toEqual(before)
})
it.each(['value', 'mapping', 'delete', 'source'] as const)('rejects stale %s with no partial ownership', async kind => {
  const plan = await draftLegacyOwnership(req(), db)
  if (kind === 'value') await db.stock.update({ where: { id: stocks[1] }, data: { available: 9 } })
  if (kind === 'mapping') await db.externalReference.updateMany({ where: { connectionId, entityType: 'location', externalId: 'WH' }, data: { externalId: 'CHANGED' } })
  if (kind === 'delete') await db.priceEntry.delete({ where: { id: prices[1] } })
  if (kind === 'source') await db.integrationConnection.update({ where: { id: connectionId }, data: { environment: 'PRODUCTION' } })
  const before = await state()
  await expect(applyLegacyOwnership(plan, plan.digest, adminId, db)).rejects.toMatchObject({ code: 'ownership_plan_stale' })
  expect(await state()).toEqual(before); expect(await db.legacyOwnershipBatch.count({ where: { storeId } })).toBe(0)
})
it('foreign ownership, partial provenance and source mismatches are explicit blockers', async () => {
  await db.priceEntry.update({ where: { id: prices[0] }, data: { sourceConnectionId: 'different-source' } })
  await db.stock.update({ where: { id: stocks[0] }, data: { sourceGenerationId: 'orphan-generation' } })
  await db.stock.update({ where: { id: stocks[1] }, data: { available: 99 } })
  const plan = await draftLegacyOwnership(req(), db)
  expect(plan.blockers.map(b => b.code).sort()).toEqual(['ownership_already_owned', 'ownership_already_owned', 'ownership_source_value_mismatch'])
  await expect(applyLegacyOwnership(plan, plan.digest, adminId, db)).rejects.toMatchObject({ code: 'ownership_plan_blocked' })
})
it('selected IDs only: new rows are not swept into an already confirmed plan', async () => {
  const plan = await draftLegacyOwnership({ ...req(), selection: { priceIds: [prices[0]], stockIds: [stocks[0]] } }, db)
  const fresh = await db.stock.create({ data: { variantId: variants[1], locationId: otherLocationId, available: 7 } })
  const receipt = await applyLegacyOwnership(plan, plan.digest, adminId, db)
  expect((await db.stock.findUniqueOrThrow({ where: { id: fresh.id } })).sourceConnectionId).toBeNull()
  expect((await db.priceEntry.findUniqueOrThrow({ where: { id: prices[1] } })).sourceConnectionId).toBeNull()
  await rollbackLegacyOwnership(receipt.id, receipt.digest, adminId, db)
})
it('ABA updates are detected by xmin even when value and business updatedAt are identical', async () => {
  const plan = await draftLegacyOwnership(req(), db), receipt = await applyLegacyOwnership(plan, plan.digest, adminId, db)
  const old = await db.stock.findUniqueOrThrow({ where: { id: stocks[0] } })
  await db.$executeRaw`UPDATE "Stock" SET available = available WHERE id = ${stocks[0]}`
  expect(await db.stock.findUniqueOrThrow({ where: { id: stocks[0] } })).toEqual(old)
  await expect(rollbackLegacyOwnership(receipt.id, receipt.digest, adminId, db)).rejects.toMatchObject({ code: 'ownership_after_state_changed' })
  expect((await db.stock.findUniqueOrThrow({ where: { id: stocks[1] } })).sourceConnectionId).toBe(connectionId)
})
it('rollback refuses to remove a mapping now used by unselected imported rows', async () => {
  const plan = await draftLegacyOwnership({ ...req(), selection: { priceIds: [prices[0]], stockIds: [] } }, db)
  const receipt = await applyLegacyOwnership(plan, plan.digest, adminId, db)
  await db.priceEntry.update({ where: { id: prices[1] }, data: { sourceConnectionId: connectionId, sourceGenerationId: generationId, sourceScopeKey: 'PT' } })
  await expect(rollbackLegacyOwnership(receipt.id, receipt.digest, adminId, db)).rejects.toMatchObject({ code: 'ownership_mapping_in_use' })
})
it('audit failure rolls back owners, new mappings and the durable receipt together', async () => {
  const plan = await draftLegacyOwnership(req(), db), before = await state()
  const failing = db.$extends({ query: { auditEntry: { create: async () => { throw new Error('audit_failure') } } } }) as unknown as PrismaClient
  await expect(applyLegacyOwnership(plan, plan.digest, adminId, failing)).rejects.toThrow('audit_failure')
  expect(await state()).toEqual(before); expect(await db.legacyOwnershipBatch.count({ where: { storeId } })).toBe(0)
})
it('refuses wrong-store actor, RUNNING jobs and cross-store selected IDs', async () => {
  const other = await db.store.create({ data: { slug: randomUUID(), name: 'Other' } })
  try {
    const p = await db.product.create({ data: { storeId: other.id, canonicalName: 'Foreign' } })
    const v = await db.productVariant.create({ data: { storeId: other.id, productId: p.id, sku: 'foreign' } })
    const w = await db.inventoryLocation.create({ data: { storeId: other.id, code: 'w', name: 'W' } })
    const row = await db.stock.create({ data: { variantId: v.id, locationId: w.id, available: -1.2 } })
    const cross = await draftLegacyOwnership({ ...req(), selection: { priceIds: [], stockIds: [row.id] } }, db)
    expect(cross.before.rows).toEqual([]); expect(cross.blockers[0].code).toBe('ownership_row_missing_or_foreign')
    const plan = await draftLegacyOwnership(req(), db)
    await expect(applyLegacyOwnership(plan, plan.digest, 'not-an-admin', db)).rejects.toMatchObject({ code: 'ownership_admin_required' })
    await db.integrationJob.create({ data: { storeId, connectionId, type: 'prices.import', idempotencyKey: randomUUID(), status: 'RUNNING' } })
    await expect(applyLegacyOwnership(plan, plan.digest, adminId, db)).rejects.toMatchObject({ code: 'source_jobs_pending' })
  } finally { await db.store.delete({ where: { id: other.id } }) }
})
it('rejects remapped, colliding and foreign targets instead of using mapping cleanup', async () => {
  const plan = await draftLegacyOwnership({ ...req(), mappings: [...req().mappings, { entityType: 'location', externalId: 'WH', entityId: otherLocationId }, { entityType: 'location', externalId: 'invented', entityId: locationId }] }, db)
  expect(plan.blockers.filter(b => b.kind === 'mapping')).toHaveLength(2)
  await expect(applyLegacyOwnership(plan, plan.digest, adminId, db)).rejects.toMatchObject({ code: 'ownership_plan_blocked' })
})

it('operator CLI requires an exact confirmation and can recover a durable receipt by digest', async () => {
  const run = promisify(execFile), file = path.join(root, 'request.json'), output = path.join(root, 'plan.json')
  await fs.writeFile(file, JSON.stringify(req()))
  const cli = (...args: string[]) => run(process.execPath, ['dist/legacy-ownership.cjs', ...args], { env: process.env, windowsHide: true })
  const draft = JSON.parse((await cli('draft', '--request', file, '--output', output)).stdout)
  expect(draft.rows).toBe(4)
  await expect(cli('apply', '--plan', output, '--confirm', 'wrong', '--actor', adminId)).rejects.toMatchObject({ stderr: expect.stringContaining('ownership_digest_mismatch') })
  const applied = JSON.parse((await cli('apply', '--plan', output, '--confirm', draft.digest, '--actor', adminId)).stdout)
  expect(JSON.parse((await cli('status', '--digest', draft.digest)).stdout).id).toBe(applied.id)
  expect(JSON.parse((await cli('rollback', '--batch', applied.id, '--confirm', draft.digest, '--actor', adminId)).stdout).status).toBe('ROLLED_BACK')
})
it('bounded write lock refuses a concurrent writer without any partial mutation', async () => {
  const plan = await draftLegacyOwnership(req(), db), before = await state()
  let release!: () => void, acquired!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { acquired = resolve })
  const holding = db.$transaction(async tx => { await tx.$executeRawUnsafe('LOCK TABLE "Stock" IN ROW EXCLUSIVE MODE'); acquired(); await gate }, { timeout: 15_000 })
  await ready
  try { await expect(applyLegacyOwnership(plan, plan.digest, adminId, db)).rejects.toThrow(/lock timeout/) }
  finally { release(); await holding }
  expect(await state()).toEqual(before); expect(await db.legacyOwnershipBatch.count({ where: { storeId } })).toBe(0)
})

it('shared product identity across sources cannot establish legacy ownership', async () => {
  const other = await db.integrationConnection.create({ data: { storeId, provider: 'ONE_C', name: 'Other source' } })
  const product = await db.productVariant.findUniqueOrThrow({ where: { id: variants[0] } })
  await db.externalReference.create({ data: { connectionId: other.id, entityType: 'product', externalId: 'foreign', entityId: product.productId } })
  const plan = await draftLegacyOwnership(req(), db)
  expect(plan.blockers.filter(b => b.code === 'ownership_product_mapping')).toHaveLength(2)
  await expect(applyLegacyOwnership(plan, plan.digest, adminId, db)).rejects.toMatchObject({ code: 'ownership_plan_blocked' })
})
it('matching amount in a different currency does not prove price provenance', async () => {
  await db.priceBook.update({ where: { id: bookId }, data: { currency: 'USD' } })
  const plan = await draftLegacyOwnership(req(), db)
  expect(plan.blockers.filter(b => b.code === 'ownership_source_value_mismatch')).toHaveLength(2)
  await expect(applyLegacyOwnership(plan, plan.digest, adminId, db)).rejects.toMatchObject({ code: 'ownership_plan_blocked' })
})
