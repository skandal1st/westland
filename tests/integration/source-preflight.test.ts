import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { previewSourceTransition } from '@/lib/integrations/preflight'
import { openExchangeSession, initializeSession, receiveChunk, finishFile, publishGeneration, authenticateSession, requireGeneration } from '@/lib/integrations/onec/ledger'
import { sealedPath, type GenerationFile } from '@/lib/integrations/onec/storage'
import { saveSourceMapping, saveSourceChannel } from '@/lib/integrations/mappings'
import { enqueueJob, JOB_CATALOG_IMPORT } from '@/lib/integrations/jobs'
import { resolveActiveSource } from '@/lib/integrations/sources'
import { sourceIdentitySku } from '@/lib/catalog/source-sku'
import { POST } from '@/app/api/staff/integrations/[id]/preflight/route'

const authState = vi.hoisted(() => ({ storeId: '', id: '', denied: false }))
vi.mock('@/lib/authz', () => ({ requireApiUser: async (roles: string[]) => {
  expect(roles).toEqual(['ADMIN'])
  return authState.denied ? { response: new Response('forbidden', { status: 403 }) } : { user: { id: authState.id, email: 'admin@test.local' } }
} }))
vi.mock('@/lib/store', () => ({ getActiveStore: async () => ({ id: authState.storeId }) }))
const db = new PrismaClient(), oldDir = process.env.ONEC_EXCHANGE_DIR
let storeId: string, activeId: string, candidateId: string, locationId: string, bookId: string, channelId: string, root: string
let actor: { id: string; email: string }
const wrap = (body: string) => `<КоммерческаяИнформация ДатаФормирования="2026-09-21T10:00:00Z">${body}</КоммерческаяИнформация>`
const product = (id = 'P1', sku = 'SKU1', name = 'Product', deleted = false) => `<Товар ${deleted ? 'Статус="Удален"' : ''}><Ид>${id}</Ид><Артикул>${sku}</Артикул><Наименование>${name}</Наименование></Товар>`
const catalog = (rows = product(), mode = 'false') => wrap(`<Каталог СодержитТолькоИзменения="${mode}"><Ид>catalog</Ид><Товары>${rows}</Товары></Каталог>`)
const offer = (id = 'P1', amount = '12.50', qty = '-2', currency = 'RUB') => `<Предложение><Ид>${id}</Ид><Цены><Цена><ИдТипаЦены>PT</ИдТипаЦены><Валюта>${currency}</Валюта><ЦенаЗаЕдиницу>${amount}</ЦенаЗаЕдиницу></Цена></Цены><Склады ИдСклада="WH" КоличествоНаСкладе="${qty}"/></Предложение>`
const offers = (rows = offer(), mode = 'false') => wrap(`<ПакетПредложений СодержитТолькоИзменения="${mode}"><Ид>offers</Ид><ТипыЦен><ТипЦены><Ид>PT</Ид></ТипЦены></ТипыЦен><Склады><Склад><Ид>WH</Ид></Склад></Склады><Предложения>${rows}</Предложения></ПакетПредложений>`)
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'r05-4-')); process.env.ONEC_EXCHANGE_DIR = root
  storeId = (await db.store.create({ data: { slug: 'r05-4-' + randomUUID(), name: 'Preflight' } })).id
  activeId = (await db.integrationConnection.create({ data: { storeId, provider: 'ONE_C', name: 'active test', environment: 'TEST', sourceState: 'ACTIVE', enabled: true } })).id
  candidateId = (await db.integrationConnection.create({ data: { storeId, provider: 'ONE_C', name: 'candidate', environment: 'PRODUCTION', sourceState: 'PREPARING', enabled: false, config: { password: 'do-not-disclose' } } })).id
  actor = await db.user.create({ data: { storeId, email: 'admin@test.local', name: 'Admin', passwordHash: 'fixture', role: 'ADMIN' } })
  authState.storeId = storeId; authState.id = actor.id; authState.denied = false
  locationId = (await db.inventoryLocation.create({ data: { storeId, name: 'Warehouse', code: 'warehouse' } })).id
  bookId = (await db.priceBook.create({ data: { storeId, name: 'Book', code: 'book', currency: 'RUB' } })).id
  channelId = (await db.fulfillmentChannel.create({ data: { storeId, inventoryLocationId: locationId, priceBookId: bookId, name: 'Channel', code: 'channel', paymentMethod: 'CASH' } })).id
  for (const [entityType, externalId, entityId] of [['location', 'WH', locationId], ['priceType', 'PT', bookId]] as const) await saveSourceMapping(storeId, candidateId, { entityType, externalId, entityId }, actor, db)
  await saveSourceMapping(storeId, candidateId, { entityType: 'seller', externalId: 'SELLER', entityId: channelId, seller: { companyName: 'Fixture seller', inn: 'test', vatEnabled: false } }, actor, db)
  await saveSourceChannel(storeId, candidateId, { channelId, warehouseExternalId: 'WH', priceTypeExternalId: 'PT', sellerExternalId: 'SELLER' }, actor, db)
})
afterEach(async () => {
  await db.order.deleteMany({ where: { storeId } })
  await db.integrationError.deleteMany({ where: { storeId } })
  await db.store.delete({ where: { id: storeId } })
})
afterAll(async () => { if (oldDir === undefined) delete process.env.ONEC_EXCHANGE_DIR; else process.env.ONEC_EXCHANGE_DIR = oldDir; await db.$disconnect() })
async function session(connectionId = candidateId) {
  const credential = { connectionId, user: 'fixture', pass: 'fixture' }
  const opened = await openExchangeSession(storeId, credential, 'fixture-secret', db)
  const authority = { storeId, sessionId: opened.id, credentials: [credential], secret: 'fixture-secret' }
  await initializeSession(authority, db); return authority
}
async function generation(cat: string | undefined = catalog(), off: string | undefined = offers(), connectionId = candidateId) {
  const authority = await session(connectionId)
  for (const [name, body] of [['import.xml', cat], ['offers.xml', off]]) if (body) {
    await receiveChunk(authority, name!, Buffer.from(body), db); await finishFile(authority, name!, db)
  }
  return publishGeneration(storeId, connectionId, [authority.sessionId], actor, db)
}
const codes = (report: Awaited<ReturnType<typeof previewSourceTransition>>) => report.blockers.map(b => b.code)
async function localProduct(source = activeId, externalId = 'P1', sku = 'SKU1') {
  const p = await db.product.create({ data: { storeId, canonicalName: 'Old name', status: 'ACTIVE', variants: { create: { storeId, sku, sourceSku: sku, status: 'ACTIVE' } } }, include: { variants: true } })
  await db.externalReference.create({ data: { connectionId: source, entityType: 'product', externalId, entityId: p.id } })
  return p
}
async function domainState() {
  return JSON.stringify(await Promise.all([
    db.integrationConnection.findMany({ where: { storeId } }),
    db.product.findMany({ where: { storeId }, include: { variants: true } }),
    db.fulfillmentChannel.findMany({ where: { storeId } }),
    db.priceEntry.findMany({ where: { variant: { storeId } } }),
    db.stock.findMany({ where: { variant: { storeId } } }),
    db.externalReference.findMany({ where: { connection: { storeId } } }),
    db.integrationJob.findMany({ where: { storeId } }),
    db.syncCursor.findMany({ where: { connection: { storeId } } }),
    db.syncCheckpoint.findMany({ where: { connection: { storeId } } }),
  ]))
}
it('PREPARING receives isolated standard uploads, previews and replays without activation or domain writes', async () => {
  const gen = await generation(), before = await domainState()
  const report = await previewSourceTransition(storeId, candidateId, gen.id, db)
  expect(report.blockers).toEqual([]); expect(report.dataReady).toBe(true); expect(report.activationAllowed).toBe(false)
  expect(report.summary).toMatchObject({ new: 1, priceRows: 1, stockRows: 1, negativeStocks: 1 })
  expect(report.values.find(v => v.kind === 'stock')).toMatchObject({ after: '-2', available: '0' })
  expect(report.values.find(v => v.kind === 'price')).toMatchObject({ after: '12.5' })
  expect(JSON.stringify(report)).not.toContain('do-not-disclose')
  expect((await previewSourceTransition(storeId, candidateId, gen.id, db)).digest).toBe(report.digest)
  expect(await domainState()).toBe(before)
  expect((await resolveActiveSource(storeId, undefined, db))?.id).toBe(activeId)
  await expect(requireGeneration(candidateId, gen.id, db)).rejects.toMatchObject({ code: 'generation_source_changed' })
  await expect(enqueueJob({ storeId, connectionId: candidateId, type: JOB_CATALOG_IMPORT }, db)).rejects.toMatchObject({ code: 'source_not_active' })
})
it('identical external IDs/SKUs across sources remain new identities; old test values are inventoried', async () => {
  const old = await localProduct()
  await db.priceEntry.create({ data: { variantId: old.variants[0].id, priceBookId: bookId, amount: 999, sourceConnectionId: activeId } })
  await db.stock.create({ data: { variantId: old.variants[0].id, locationId, available: 55, sourceConnectionId: activeId } })
  const gen = await generation(), report = await previewSourceTransition(storeId, candidateId, gen.id, db)
  expect(report.dataReady).toBe(true); expect(report.testData).toEqual({ prices: 1, stocks: 1 })
  expect(report.collisions.map(c => c.kind).sort()).toEqual(['externalId', 'sku'])
  expect(report.products[0]).toMatchObject({ change: 'new', productId: null, internalSku: sourceIdentitySku(candidateId, 'P1') })
  expect(await db.product.count({ where: { storeId } })).toBe(1)
})
it('reports changed and absent owned products and refuses ambiguous variants or foreign ownership', async () => {
  const existing = await localProduct(candidateId), absent = await localProduct(candidateId, 'P2', 'SKU2')
  const gen = await generation(), report = await previewSourceTransition(storeId, candidateId, gen.id, db)
  expect(report.products).toEqual(expect.arrayContaining([expect.objectContaining({ productId: existing.id, change: 'changed' }), expect.objectContaining({ productId: absent.id, change: 'absent' })]))
  await db.productVariant.create({ data: { storeId, productId: existing.id, sku: 'AMBIGUOUS' } })
  await db.externalReference.create({ data: { connectionId: activeId, entityType: 'product', externalId: 'shared', entityId: existing.id } })
  expect(codes(await previewSourceTransition(storeId, candidateId, gen.id, db))).toEqual(expect.arrayContaining(['variant_identity_ambiguous', 'product_source_conflict']))
})
it('duplicate articles allocate deterministically; occupied fallback is a blocker', async () => {
  const gen = await generation(catalog(product('Z', 'SAME') + product('A', 'SAME')), offers(offer('Z') + offer('A')))
  const report = await previewSourceTransition(storeId, candidateId, gen.id, db)
  expect(report.dataReady).toBe(true)
  expect(report.products.map(p => [p.externalId, p.internalSku])).toEqual([['A', 'SAME'], ['Z', sourceIdentitySku(candidateId, 'Z')]])
  await localProduct(activeId, 'fallback', sourceIdentitySku(candidateId, 'Z'))
  expect(codes(await previewSourceTransition(storeId, candidateId, gen.id, db))).toContain('source_identity_sku_conflict')
})
it.each(['missing', 'catalog-only', 'delta', 'unknown'])('blocks incomplete generation: %s', async mode => {
  const gen = mode === 'missing' ? null : await generation(catalog(product(), mode === 'delta' ? 'true' : 'false'), mode === 'catalog-only' ? '' : mode === 'unknown' ? offers().replace(' СодержитТолькоИзменения="false"', '') : offers())
  const report = await previewSourceTransition(storeId, candidateId, gen?.id, db)
  expect(report.dataReady).toBe(false); expect(report.activationAllowed).toBe(false)
  expect(codes(report)).toContain(mode === 'missing' ? 'generation_required' : mode === 'catalog-only' ? 'generation_streams_incomplete' : 'full_generation_required')
})
it('unfinished upload cannot publish; a later partial session never substitutes for a selected full generation', async () => {
  const complete = await generation(), authority = await session()
  await receiveChunk(authority, 'import.xml', Buffer.from('<КоммерческаяИнформация>'), db)
  await expect(publishGeneration(storeId, candidateId, [authority.sessionId], actor, db)).rejects.toMatchObject({ code: 'session_files_incomplete' })
  const report = await previewSourceTransition(storeId, candidateId, complete.id, db)
  expect(report.generation?.id).toBe(complete.id); expect(report.uploads.open).toBe(1)
  expect(codes(report)).toContain('incomplete_uploads')
  expect((await previewSourceTransition(storeId, candidateId, undefined, db)).dataReady).toBe(false)
})
it('missing mappings, incomplete channels and currency mismatch are blocking', async () => {
  const gen = await generation(catalog(), offers(offer('P1', '3', '2', 'USD')))
  await db.externalReference.deleteMany({ where: { connectionId: candidateId, entityType: 'location' } })
  expect(codes(await previewSourceTransition(storeId, candidateId, gen.id, db))).toEqual(expect.arrayContaining(['warehouse_unmapped', 'channel_mappings_incomplete', 'price_currency_mismatch']))
})
it('cross-store targets are blocked and another store cannot inspect this candidate', async () => {
  const gen = await generation()
  await db.externalReference.updateMany({ where: { connectionId: candidateId, entityType: 'location' }, data: { entityId: 'foreign-location' } })
  expect(codes(await previewSourceTransition(storeId, candidateId, gen.id, db))).toContain('mapping_target_not_found')
  await expect(previewSourceTransition('other-store', candidateId, gen.id, db)).rejects.toMatchObject({ code: 'source_not_found', status: 404 })
})
it('corrupt files, corrupt manifest, foreign and stale generations never appear ready', async () => {
  const gen = await generation(), other = await generation(catalog(), offers(), activeId)
  expect(codes(await previewSourceTransition(storeId, candidateId, other.id, db))).toContain('generation_source_changed')
  const file = (gen.files as unknown as GenerationFile[])[0]
  await fs.writeFile(sealedPath(candidateId, file), 'corrupt')
  expect(codes(await previewSourceTransition(storeId, candidateId, gen.id, db))).toContain('generation_file_integrity_failed')
  await db.onecGeneration.update({ where: { id: gen.id }, data: { digest: 'bad' } })
  expect(codes(await previewSourceTransition(storeId, candidateId, gen.id, db))).toContain('generation_manifest_invalid')
  await db.integrationConnection.update({ where: { id: candidateId }, data: { exchangeRevision: { increment: 1 } } })
  expect(codes(await previewSourceTransition(storeId, candidateId, gen.id, db))).toContain('generation_source_changed')
})
it('catalog tombstones reconcile offers only within selected full generation', async () => {
  const gen = await generation(catalog(product('P1', 'SKU1', 'Deleted', true)), offers())
  const report = await previewSourceTransition(storeId, candidateId, gen.id, db)
  expect(report.dataReady).toBe(true); expect(report.values).toHaveLength(0)
  expect(report.warnings.map(w => w.code)).toContain('catalog_tombstone_precedes_offer')
  const next = await generation(catalog(product('P2')), offers())
  expect(codes(await previewSourceTransition(storeId, candidateId, next.id, db))).toContain('offer_product_missing_from_catalog')
})
it.each([
  ['duplicate_product_identity', () => catalog(product() + product()), () => offers()],
  ['duplicate_offer_identity', () => catalog(), () => offers(offer() + offer())],
  ['source_number_precision', () => catalog(), () => offers(offer('P1', '1.234'))],
])('reports %s', async (code, cat, off) => {
  const gen = await generation(cat(), off())
  expect(codes(await previewSourceTransition(storeId, candidateId, gen.id, db))).toContain(code)
})
it('full-scope cleanup reports unowned prices/stocks even when their offer is absent', async () => {
  const p = await localProduct(candidateId)
  await db.priceEntry.create({ data: { variantId: p.variants[0].id, priceBookId: bookId, amount: 4 } })
  await db.stock.create({ data: { variantId: p.variants[0].id, locationId, available: 5 } })
  const gen = await generation(catalog(), offers(''))
  expect(codes(await previewSourceTransition(storeId, candidateId, gen.id, db))).toEqual(expect.arrayContaining(['price_source_conflict', 'stock_source_conflict']))
})
it('pending jobs, checkpoints, runs, draft orders and failed exports remain tied to old source', async () => {
  const gen = await generation()
  await db.integrationJob.create({ data: { storeId, connectionId: activeId, type: 'catalog.import', idempotencyKey: randomUUID(), status: 'RETRYING' } })
  await db.syncCheckpoint.create({ data: { connectionId: activeId, entityType: 'product', completed: false } })
  await db.syncRun.create({ data: { connectionId: activeId, entityType: 'all', status: 'RUNNING' } })
  const customer = await db.customer.create({ data: { storeId, displayName: 'Buyer', legalName: 'Buyer LLC', inn: 'fixture' } })
  const address = await db.customerLocation.create({ data: { customerId: customer.id, name: 'Address', address: 'Fixture', city: 'Test' } })
  const order = await db.order.create({ data: { storeId, customerId: customer.id, userId: actor.id, deliveryLocationId: address.id, inventoryLocationId: locationId, fulfillmentChannelId: channelId, paymentMethod: 'CASH', number: randomUUID(), total: 1,
    export: { create: { storeId, connectionId: activeId, status: 'FAILED' } } } })
  const report = await previewSourceTransition(storeId, candidateId, gen.id, db)
  expect(codes(report)).toEqual(expect.arrayContaining(['unfinished_jobs', 'unfinished_runs', 'unfinished_checkpoints', 'unfinished_orders', 'unfinished_exports']))
  expect(report.pending.orders.find(o => o.id === order.id)?.export?.connectionId).toBe(activeId)
})
it('new DB client and mapping change produce a fresh context; old report cannot activate anything', async () => {
  const gen = await generation(), first = await previewSourceTransition(storeId, candidateId, gen.id, db)
  await db.priceBook.update({ where: { id: bookId }, data: { currency: 'USD' } })
  const restarted = new PrismaClient()
  try {
    const second = await previewSourceTransition(storeId, candidateId, gen.id, restarted)
    expect(second.digest).not.toBe(first.digest); expect(codes(second)).toContain('price_currency_mismatch')
    expect(second.activationAllowed).toBe(false)
  } finally { await restarted.$disconnect() }
})
it('retirement invalidates preparation cookies; unclassified or enabled PREPARING rejects uploads', async () => {
  const authority = await session()
  await db.integrationConnection.update({ where: { id: candidateId }, data: { sourceState: 'RETIRED' } })
  await expect(authenticateSession(authority, db)).rejects.toMatchObject({ code: 'session_source_changed' })
  await expect(session()).rejects.toMatchObject({ code: 'source_not_active' })
  await db.integrationConnection.update({ where: { id: candidateId }, data: { sourceState: 'PREPARING', environment: 'UNCLASSIFIED' } })
  await expect(session()).rejects.toMatchObject({ code: 'source_not_active' })
  await db.integrationConnection.update({ where: { id: candidateId }, data: { environment: 'TEST', enabled: true } })
  await expect(session()).rejects.toMatchObject({ code: 'source_not_active' })
})
it('ADMIN endpoint checks scope, refuses activation payload, audits and sets no-store', async () => {
  const gen = await generation()
  const request = (body: unknown) => new Request('http://test/preflight', { method: 'POST', body: JSON.stringify(body) })
  authState.denied = true
  expect((await POST(request({ generationId: gen.id }), { params: { id: candidateId } })).status).toBe(403)
  authState.denied = false
  expect((await POST(request({ generationId: gen.id, activate: true }), { params: { id: candidateId } })).status).toBe(400)
  const response = await POST(request({ generationId: gen.id }), { params: { id: candidateId } })
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toMatchObject({ activationAllowed: false, dataReady: true })
  expect(await db.auditEntry.count({ where: { storeId, action: 'SourceTransitionPreviewed' } })).toBe(1)
  authState.storeId = 'other-store'
  expect((await POST(request({ generationId: gen.id }), { params: { id: candidateId } })).status).toBe(404)
})

it('standard HTTP exchange accepts candidate files but refuses sale and wrong-source cookies', async () => {
  const { handleOnecExchange } = await import('@/lib/integrations/onec/http')
  const previous = { secret: process.env.NEXTAUTH_SECRET, file: process.env.ONEC_SOURCES_FILE }
  process.env.NEXTAUTH_SECRET = 'r05-4-http-test'
  process.env.ONEC_SOURCES_FILE = path.join(root, 'credentials.json')
  await fs.writeFile(process.env.ONEC_SOURCES_FILE, JSON.stringify([{ connectionId: candidateId, user: 'candidate', pass: 'fixture-password' }]))
  try {
    const base = 'http://test/api/integrations/1c/exchange'
    const login = await handleOnecExchange(new Request(base + '?type=catalog&mode=checkauth', { headers: { authorization: 'Basic ' + Buffer.from('candidate:fixture-password').toString('base64') } }))
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const call = (query: string, body?: string) => handleOnecExchange(new Request(base + query, { headers: { cookie }, ...(body === undefined ? {} : { method: 'POST', body }) }))
    expect((await call('?type=catalog&mode=init')).status).toBe(200)
    expect((await call('?type=catalog&mode=file&filename=import.xml', catalog())).status).toBe(200)
    expect((await call('?type=catalog&mode=import&filename=import.xml')).status).toBe(200)
    expect((await call('?type=sale&mode=query')).status).toBe(503)
    authState.storeId = 'wrong-store'
    expect((await call('?type=catalog&mode=init')).status).toBe(401)
    expect(await db.product.count({ where: { storeId } })).toBe(0)
  } finally {
    if (previous.secret === undefined) delete process.env.NEXTAUTH_SECRET; else process.env.NEXTAUTH_SECRET = previous.secret
    if (previous.file === undefined) delete process.env.ONEC_SOURCES_FILE; else process.env.ONEC_SOURCES_FILE = previous.file
  }
})

it('expired abandoned uploads remain visible but cannot hold preparation blocked forever', async () => {
  const gen = await generation(), authority = await session()
  await receiveChunk(authority, 'import.xml', Buffer.from('<КоммерческаяИнформация>'), db)
  await db.onecExchangeSession.update({ where: { id: authority.sessionId }, data: { expiresAt: new Date(0) } })
  const report = await previewSourceTransition(storeId, candidateId, gen.id, db)
  expect(report.dataReady).toBe(true)
  expect(report.warnings.map(w => w.code)).toContain('expired_incomplete_uploads')
  await expect(authenticateSession(authority, db)).rejects.toMatchObject({ code: 'session_expired_or_unknown' })
})
