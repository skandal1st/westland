import { beforeEach, afterEach, afterAll, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openExchangeSession, initializeSession, receiveChunk, finishFile, publishGeneration } from '@/lib/integrations/onec/ledger'
import { createOneCProvider } from '@/lib/integrations/onec/provider'
import { sourceIdentitySku } from '@/lib/catalog/source-sku'
import { importCatalog } from '@/lib/integrations/import-catalog'
import { importPrices } from '@/lib/integrations/import-prices'
import { importAvailability } from '@/lib/integrations/import-availability'
import { saveSourceMapping, saveSourceChannel } from '@/lib/integrations/mappings'
import { listCatalog } from '@/lib/catalog/read'
import { projectChannelAvailability } from '@/lib/pricing/availability'

const db = new PrismaClient(), oldDir = process.env.ONEC_EXCHANGE_DIR
let storeId: string, connectionId: string, root: string, actor: { id: string; email: string }, bookA: string, bookB: string, location: string, channel: string
const wrap = (body: string, date = '2026-09-20T10:00:00Z') => `<КоммерческаяИнформация ДатаФормирования="${date}">${body}</КоммерческаяИнформация>`
const catalog = (ids: string[], mode = 'false') => wrap(`<Каталог ${mode ? `СодержитТолькоИзменения="${mode}"` : ''}><Ид>cat</Ид><Товары>${ids.map(id => `<Товар><Ид>${id}</Ид><Артикул>${id}</Артикул><Наименование>Product ${id}</Наименование></Товар>`).join('')}</Товары></Каталог>`)
const price = (id: string, amount: number, currency = 'RUB') => `<Цена><ИдТипаЦены>${id}</ИдТипаЦены><Валюта>${currency}</Валюта><ЦенаЗаЕдиницу>${amount}</ЦенаЗаЕдиницу></Цена>`
const offer = (id: string, prices = price('PT-A', 10), qty: number | null = 5) => `<Предложение><Ид>${id}</Ид><Цены>${prices}</Цены>${qty === null ? '' : `<Склады ИдСклада="WH" КоличествоНаСкладе="${qty}"/>`}</Предложение>`
const offers = (rows: string, mode = 'false', scopes = true, date?: string) => wrap(`<ПакетПредложений ${mode ? `СодержитТолькоИзменения="${mode}"` : ''}><Ид>offers</Ид>${scopes ? '<ТипыЦен><ТипЦены><Ид>PT-A</Ид></ТипЦены><ТипЦены><Ид>PT-B</Ид></ТипЦены></ТипыЦен><Склады><Склад><Ид>WH</Ид></Склад></Склады>' : ''}<Предложения>${rows}</Предложения></ПакетПредложений>`, date)
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'onec-r11-')); process.env.ONEC_EXCHANGE_DIR = root
  storeId = (await db.store.create({ data: { slug: `r11-${randomUUID()}`, name: 'R11' } })).id
  connectionId = (await db.integrationConnection.create({ data: { storeId, name: 'A', provider: 'ONE_C', enabled: true, sourceState: 'ACTIVE', environment: 'TEST' } })).id
  actor = await db.user.create({ data: { storeId, email: 'admin@test.local', name: 'Admin', passwordHash: 'fixture', role: 'ADMIN' } })
  bookA = (await db.priceBook.create({ data: { storeId, code: 'a', name: 'A', currency: 'RUB', isDefault: true } })).id
  bookB = (await db.priceBook.create({ data: { storeId, code: 'b', name: 'B', currency: 'RUB' } })).id
  location = (await db.inventoryLocation.create({ data: { storeId, code: 'w', name: 'W' } })).id
  channel = (await db.fulfillmentChannel.create({ data: { storeId, code: 'c', name: 'C', inventoryLocationId: location, priceBookId: bookA, paymentMethod: 'CASH' } })).id
  for (const [entityType, externalId, entityId] of [['priceType', 'PT-A', bookA], ['priceType', 'PT-B', bookB], ['location', 'WH', location]] as const) await saveSourceMapping(storeId, connectionId, { entityType, externalId, entityId }, actor, db)
})
afterEach(async () => {
  await db.providerSnapshot.deleteMany({ where: { storeId } }); await db.inbox.deleteMany({ where: { storeId } }); await db.integrationError.deleteMany({ where: { storeId } }); await db.store.delete({ where: { id: storeId } })
})
afterAll(async () => { if (oldDir === undefined) delete process.env.ONEC_EXCHANGE_DIR; else process.env.ONEC_EXCHANGE_DIR = oldDir; await db.$disconnect() })
async function generation(cat?: string, off?: string) {
  const credential = { connectionId, user: 'test', pass: 'test' }, secret = 'test'
  const opened = await openExchangeSession(storeId, credential, secret, db)
  const authority = { storeId, sessionId: opened.id, credentials: [credential], secret }
  await initializeSession(authority, db)
  for (const [name, body] of [['import.xml', cat], ['offers.xml', off]]) if (body) { await receiveChunk(authority, name!, Buffer.from(body), db); await finishFile(authority, name!, db) }
  const gen = await publishGeneration(storeId, connectionId, [opened.id], actor, db)
  const provider = createOneCProvider(connectionId, gen.id)
  return { storeId, connectionId, generationId: gen.id, provider }
}
async function seed() {
  const input = await generation(catalog(['P1', 'P2']), offers(offer('P1') + offer('P2')))
  await importCatalog(input, db); await importPrices(input, db); await importAvailability(input, db)
  return input
}
async function amounts() { return (await db.priceEntry.findMany({ where: { variant: { storeId } }, include: { variant: true }, orderBy: { variant: { sku: 'asc' } } })).map(p => [p.variant.sku, Number(p.amount), p.priceBookId]) }

it('price tuples preserve XML order independence and currency by explicit source mapping', async () => {
  const input = await generation(catalog(['P1']), offers(offer('P1', price('PT-B', 99) + price('PT-A', 11))))
  await importCatalog(input, db); expect(await importPrices(input, db)).toEqual({ imported: 2, failed: 0 })
  expect(await amounts()).toEqual(expect.arrayContaining([['P1', 11, bookA], ['P1', 99, bookB]]))
  const reversed = await generation(undefined, offers(offer('P1', price('PT-A', 11) + price('PT-B', 99)), 'true'))
  await importPrices(reversed, db); expect(await amounts()).toHaveLength(2)
})
it.each([['unknown', 'UNKNOWN', 'RUB', 'price_type_unmapped'], ['currency', 'PT-A', 'USD', 'price_currency_mismatch']])('%s rolls back every price and absence cleanup', async (_label, type, currency, code) => {
  await seed(); const before = await amounts()
  const input = await generation(undefined, offers(offer('P1', price('PT-A', 20)) + offer('P2', price(type, 30, currency))))
  await expect(importPrices(input, db)).rejects.toMatchObject({ code })
  expect(await amounts()).toEqual(before)
})
it('delta preserves absent rows, zero removes price and writes known zero stock', async () => {
  await seed()
  const input = await generation(undefined, offers(offer('P1', price('PT-A', 0), 0), 'true'))
  await importPrices(input, db); await importAvailability(input, db)
  expect(await amounts()).toEqual([['P2', 10, bookA]])
  const rows = await db.stock.findMany({ where: { variant: { storeId } }, include: { variant: true } })
  expect(rows.find(r => r.variant.sku === 'P1')?.available.toString()).toBe('0')
  expect(rows.find(r => r.variant.sku === 'P2')?.available.toString()).toBe('5')
})
it('successful full removes absent prices, stock and old channel projections', async () => {
  await seed(); const input = await generation(undefined, offers(offer('P1', price('PT-A', 30), 2)))
  await importPrices(input, db); await importAvailability(input, db)
  expect(await amounts()).toEqual([['P1', 30, bookA]])
  expect(await db.stock.count({ where: { variant: { storeId } } })).toBe(1)
  expect(await db.availabilityProjection.count({ where: { variant: { storeId } } })).toBe(1)
})
it('empty full with declared scope clears values, empty delta preserves them', async () => {
  await seed(); const delta = await generation(undefined, offers('', 'true'))
  await importPrices(delta, db); await importAvailability(delta, db); expect(await amounts()).toHaveLength(2)
  const full = await generation(undefined, offers(''))
  await importPrices(full, db); await importAvailability(full, db); expect(await amounts()).toHaveLength(0)
  expect(await db.availabilityProjection.count({ where: { variant: { storeId } } })).toBe(0)
})
it('full scope is mandatory and unknown mode never removes absent rows', async () => {
  await seed(); const unknown = await generation(undefined, offers(offer('P1'), '', false))
  await importPrices(unknown, db); expect(await amounts()).toHaveLength(2)
  const noScope = await generation(undefined, offers(offer('P1'), 'false', false))
  await expect(importPrices(noScope, db)).rejects.toMatchObject({ code: 'full_scope_required' })
  expect(await amounts()).toHaveLength(2)
})
it('catalog full archives missing entities only after success; reappearance preserves variant ID', async () => {
  await seed(); const p2 = await db.productVariant.findUniqueOrThrow({ where: { storeId_sku: { storeId, sku: 'P2' } } })
  const full = await generation(catalog(['P1']))
  await importCatalog(full, db)
  expect((await db.productVariant.findUniqueOrThrow({ where: { id: p2.id } })).status).toBe('ARCHIVED')
  expect(await amounts()).toEqual([['P1', 10, bookA]])
  const delta = await generation(catalog(['P2'], 'true'))
  await importCatalog(delta, db)
  expect((await db.productVariant.findUniqueOrThrow({ where: { storeId_sku: { storeId, sku: 'P2' } } })).id).toBe(p2.id)
  expect((await listCatalog({ storeId })).total).toBe(2)
})
it('invalid catalog row cannot masquerade as absence in a full exchange', async () => {
  await seed(); const input = await generation(catalog(['P1']).replace('<Артикул>P1</Артикул>', ''))
  await expect(importCatalog(input, db)).rejects.toThrow('invalid_catalog_product')
  expect((await listCatalog({ storeId })).total).toBe(2)
})
it('occupied derived identity after a valid row rolls back updates and keeps checkpoint unchanged', async () => {
  await seed()
  const p2 = await db.productVariant.findUniqueOrThrow({ where: { storeId_sku: { storeId, sku: 'P2' } } })
  await db.productVariant.create({ data: { storeId, productId: p2.productId, sku: sourceIdentitySku(connectionId, 'P3'), isDefault: false } })
  const checkpoint = await db.syncCheckpoint.findFirstOrThrow({ where: { connectionId } })
  const input = await generation(catalog(['P1', 'P3']).replace('<Наименование>Product P1', '<Наименование>Changed P1').replace('<Артикул>P3', '<Артикул>P2'))
  await expect(importCatalog(input, db)).rejects.toThrow('source_identity_sku_conflict')
  expect(await db.syncCheckpoint.findFirstOrThrow({ where: { connectionId } })).toEqual(checkpoint)
  expect((await listCatalog({ storeId })).total).toBe(2)
  expect(await db.product.count({ where: { storeId, canonicalName: 'Changed P1' } })).toBe(0)
})
it('id-only deletion archives catalog or removes offer values without deleting historical identity', async () => {
  await seed(); const input = await generation(undefined, offers('<Предложение Статус="Удален"><Ид>P1</Ид></Предложение>', 'true'))
  await importPrices(input, db); await importAvailability(input, db)
  expect(await amounts()).toEqual([['P2', 10, bookA]])
  const del = await generation(wrap('<Каталог СодержитТолькоИзменения="true"><Товары><Товар Статус="Удален"><Ид>P2</Ид></Товар></Товары></Каталог>'))
  await importCatalog(del, db); expect((await listCatalog({ storeId })).total).toBe(1)
  expect(await db.productVariant.count({ where: { storeId } })).toBe(2)
})
it('unknown timestamp is stale, while explicit timezone timestamp is preserved', async () => {
  await seed(); const input = await generation(undefined, offers(offer('P1'), 'true', true, '2026-09-20T10:00:00'))
  await importAvailability(input, db)
  const rows = await listCatalog({ storeId, channelId: channel })
  expect(rows.items.find(r => r.sku === 'P1')?.availability?.stale).toBe(true)
  expect((await db.stock.findFirstOrThrow({ where: { variant: { storeId, sku: 'P1' } } })).sourceUpdatedAt).toBeNull()
})
it('an older already-published generation cannot overwrite newer applied data', async () => {
  const old = await seed(), newer = await generation(undefined, offers(offer('P1', price('PT-A', 40)), 'true'))
  await importPrices(newer, db)
  await expect(importPrices(old, db)).rejects.toMatchObject({ code: 'older_generation_rejected' })
  expect(await amounts()).toContainEqual(['P1', 40, bookA])
})
it('remapped warehouse removes previous owned stock and rebuilds projections', async () => {
  await seed(); const next = await db.inventoryLocation.create({ data: { storeId, code: 'next', name: 'Next' } })
  await saveSourceMapping(storeId, connectionId, { entityType: 'location', externalId: 'WH', entityId: next.id }, actor, db)
  const input = await generation(undefined, offers(offer('P1'), 'true'))
  await importAvailability(input, db)
  expect(await db.stock.count({ where: { locationId: location, variant: { sku: 'P1' } } })).toBe(0)
  expect(await db.availabilityProjection.count({ where: { fulfillmentChannelId: channel, variant: { sku: 'P1' } } })).toBe(0)
})
it('channel rebuild removes rows when destination warehouse has no stock', async () => {
  await seed(); const next = await db.inventoryLocation.create({ data: { storeId, code: 'empty', name: 'Empty' } })
  await db.fulfillmentChannel.update({ where: { id: channel }, data: { inventoryLocationId: next.id } })
  await projectChannelAvailability(channel, db)
  expect(await db.availabilityProjection.count({ where: { fulfillmentChannelId: channel } })).toBe(0)
})
it('same GUIDs have separate price/warehouse/customer/seller mappings; PREPARING leaves active channels intact', async () => {
  await seed(); const b = await db.integrationConnection.create({ data: { storeId, name: 'B', provider: 'ONE_C', environment: 'PRODUCTION' } })
  const customer = await db.customer.create({ data: { storeId, inn: 'test-only', legalName: 'Test', displayName: 'Test' } })
  for (const id of [connectionId, b.id]) {
    await saveSourceMapping(storeId, id, { entityType: 'customer', externalId: 'BUYER', entityId: customer.id }, actor, db)
    await saveSourceMapping(storeId, id, { entityType: 'seller', externalId: 'SELLER', entityId: channel, seller: { companyName: id, inn: 'test-only', vatEnabled: false } }, actor, db)
  }
  await saveSourceMapping(storeId, b.id, { entityType: 'priceType', externalId: 'PT-A', entityId: bookB }, actor, db)
  await saveSourceMapping(storeId, b.id, { entityType: 'location', externalId: 'WH', entityId: location }, actor, db)
  expect(await saveSourceChannel(storeId, b.id, { channelId: channel, warehouseExternalId: 'WH', priceTypeExternalId: 'PT-A', sellerExternalId: 'SELLER' }, actor, db)).toEqual({ applied: false })
  expect((await db.fulfillmentChannel.findUniqueOrThrow({ where: { id: channel } })).priceBookId).toBe(bookA)
  expect(await saveSourceChannel(storeId, connectionId, { channelId: channel, warehouseExternalId: 'WH', priceTypeExternalId: 'PT-A', sellerExternalId: 'SELLER' }, actor, db)).toEqual({ applied: true })
  expect((await db.fulfillmentChannel.findUniqueOrThrow({ where: { id: channel } })).sellerLegalEntity).toMatchObject({ companyName: connectionId })
})
it('cross-store targets and sharing a product between two sources are rejected', async () => {
  await seed(); const other = await db.store.create({ data: { slug: randomUUID(), name: 'Other' } })
  try {
    const foreign = await db.priceBook.create({ data: { storeId: other.id, code: 'foreign', name: 'foreign' } })
    await expect(saveSourceMapping(storeId, connectionId, { entityType: 'priceType', externalId: 'FOREIGN', entityId: foreign.id }, actor, db)).rejects.toMatchObject({ code: 'mapping_target_not_found' })
    const b = await db.integrationConnection.create({ data: { storeId, name: 'B', provider: 'ONE_C' } })
    const p1 = await db.productVariant.findUniqueOrThrow({ where: { storeId_sku: { storeId, sku: 'P1' } } })
    await expect(saveSourceMapping(storeId, b.id, { entityType: 'product', externalId: 'P1', entityId: p1.productId }, actor, db)).rejects.toMatchObject({ code: 'product_source_conflict' })
  } finally { await db.store.delete({ where: { id: other.id } }) }
})
it('switching source with the same article creates a separate identity without claiming the old product or values', async () => {
  await seed()
  const old = await db.productVariant.findMany({ where: { storeId }, orderBy: { id: 'asc' } })
  const oldAmounts = await amounts()
  await db.integrationConnection.update({ where: { id: connectionId }, data: { enabled: false, sourceState: 'RETIRED' } })
  connectionId = (await db.integrationConnection.create({ data: { storeId, name: 'B', provider: 'ONE_C', enabled: true, sourceState: 'ACTIVE' } })).id
  const input = await generation(catalog(['P1']))
  await importCatalog(input, db)
  expect((await listCatalog({ storeId })).total).toBe(3)
  expect(await db.productVariant.findMany({ where: { id: { in: old.map(v => v.id) } }, orderBy: { id: 'asc' } })).toEqual(old)
  expect(await amounts()).toEqual(oldAmounts)
  const ref = await db.externalReference.findFirstOrThrow({ where: { connectionId, entityType: 'product' } })
  expect(old.map(v => v.productId)).not.toContain(ref.entityId)
  expect(await db.productVariant.findFirstOrThrow({ where: { productId: ref.entityId } })).toMatchObject({ sku: sourceIdentitySku(connectionId, 'P1'), sourceSku: 'P1' })
})

it('legacy unowned values are not silently claimed or overwritten', async () => {
  await seed(); await db.priceEntry.updateMany({ where: { variant: { storeId } }, data: { sourceConnectionId: null } })
  const input = await generation(undefined, offers(offer('P1', price('PT-A', 40))))
  await expect(importPrices(input, db)).rejects.toMatchObject({ code: 'price_source_conflict' })
  expect(await amounts()).toEqual([['P1', 10, bookA], ['P2', 10, bookA]])
})

it('price-only full leaves stock intact, while unsupported fractional prices never become a free item', async () => {
  await seed()
  const input = await generation(undefined, offers(offer('P1', price('PT-A', 15), null)).replace('<Склады><Склад><Ид>WH</Ид></Склад></Склады>', ''))
  await importPrices(input, db); await importAvailability(input, db)
  expect(await db.stock.count({ where: { variant: { storeId } } })).toBe(2)
  const tiny = await generation(undefined, offers(offer('P1', price('PT-A', 0.001)), 'true'))
  await expect(importPrices(tiny, db)).rejects.toMatchObject({ code: 'source_number_precision' })
  expect(await amounts()).toEqual([['P1', 15, bookA]])
})
it('stock full error rolls back valid preceding rows and preserves old projections', async () => {
  await seed()
  const input = await generation(undefined, offers(offer('P1', '', 99) + offer('P2', '', 1).replace('ИдСклада="WH"', 'ИдСклада="UNKNOWN"')))
  await expect(importAvailability(input, db)).rejects.toMatchObject({ code: 'warehouse_unmapped' })
  expect((await db.stock.findFirstOrThrow({ where: { variant: { storeId, sku: 'P1' } } })).available.toString()).toBe('5')
  expect(await db.availabilityProjection.count({ where: { fulfillmentChannelId: channel } })).toBe(2)
})
it('duplicate price identities reject the full stream instead of last-write-wins', async () => {
  await seed(); const input = await generation(undefined, offers(offer('P1', price('PT-A', 12) + price('PT-A', 13))))
  await expect(importPrices(input, db)).rejects.toMatchObject({ code: 'duplicate_source_value' })
  expect(await amounts()).toHaveLength(2)
})
it('full cleanup keeps source values in price types outside the declared scope', async () => {
  await seed(); const b = await generation(undefined, offers(offer('P1', price('PT-B', 99)), 'true'))
  await importPrices(b, db)
  const a = await generation(undefined, offers(offer('P1', price('PT-A', 14))).replace('<ТипЦены><Ид>PT-B</Ид></ТипЦены>', ''))
  await importPrices(a, db)
  expect(await amounts()).toEqual(expect.arrayContaining([['P1', 14, bookA], ['P1', 99, bookB]]))
  expect(await amounts()).toHaveLength(2)
})

it('empty full refuses to claim or silently retain legacy rows in its owned product scope', async () => {
  await seed(); await db.stock.updateMany({ where: { variant: { storeId } }, data: { sourceConnectionId: null } })
  const empty = await generation(undefined, offers(''))
  await expect(importAvailability(empty, db)).rejects.toMatchObject({ code: 'stock_source_conflict' })
  expect(await db.stock.count({ where: { variant: { storeId } } })).toBe(2)
})


it('signed raw stocks retain warehouse isolation, timestamps and replay identity while prices import', async () => {
  const other = await db.inventoryLocation.create({ data: { storeId, code: 'w2', name: 'W2' } })
  await saveSourceMapping(storeId, connectionId, { entityType: 'location', externalId: 'WH2', entityId: other.id }, actor, db)
  const c2 = await db.fulfillmentChannel.create({ data: { storeId, code: 'c2', name: 'C2', inventoryLocationId: other.id, priceBookId: bookA, paymentMethod: 'CASH' } })
  const xml = offers(offer('P1', price('PT-A', 17), -1.125).replace('</Предложение>', '<Количество>-88</Количество><Склады ИдСклада="WH2" КоличествоНаСкладе="7.5"/></Предложение>'))
    .replace('<Склады><Склад>', '<Склады><Склад><Ид>WH2</Ид></Склад><Склад>')
  const input = await generation(catalog(['P1']), xml)
  await importCatalog(input, db); await importPrices(input, db); await importAvailability(input, db)
  expect(await amounts()).toEqual([['P1', 17, bookA]])
  const rows = await db.stock.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
  expect(rows.find(r => r.locationId === location)).toMatchObject({ sourceConnectionId: connectionId, sourceGenerationId: input.generationId, sourceScopeKey: 'WH', sourceUpdatedAt: new Date('2026-09-20T10:00:00Z') })
  expect(rows.find(r => r.locationId === location)?.available.toString()).toBe('-1.125')
  expect(rows.find(r => r.locationId === other.id)?.available.toString()).toBe('7.5')
  const projected = await db.availabilityProjection.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
  expect(projected.find(r => r.fulfillmentChannelId === channel)?.availableQuantity.toString()).toBe('0')
  expect(projected.find(r => r.fulfillmentChannelId === c2.id)?.availableQuantity.toString()).toBe('7.5')
  await importAvailability(input, db)
  const repeated = await db.availabilityProjection.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
  expect(repeated.map(({ updatedAt: _at, ...r }) => r)).toEqual(projected.map(({ updatedAt: _at, ...r }) => r))
  expect((await db.stock.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })).map(r => [r.id, r.available.toString()])).toEqual(rows.map(r => [r.id, r.available.toString()]))
  expect((await listCatalog({ storeId, channelId: channel })).items[0].availability?.available).toBe(0)
  expect((await listCatalog({ storeId, channelId: c2.id })).items[0].availability?.available).toBe(7.5)
})
it('negative delta preserves absent stock and recovery to positive keeps the same projection', async () => {
  await seed()
  const before = await db.availabilityProjection.findFirstOrThrow({ where: { variant: { storeId, sku: 'P1' } } })
  for (const value of [-2, 0, 3]) {
    const input = await generation(undefined, offers(offer('P1', price('PT-A', 20), value), 'true'))
    await importAvailability(input, db)
    const projection = await db.availabilityProjection.findUniqueOrThrow({ where: { id: before.id } })
    expect(projection.availableQuantity.toNumber()).toBe(Math.max(0, value))
    expect((await db.stock.findFirstOrThrow({ where: { variant: { storeId, sku: 'P2' } } })).available.toString()).toBe('5')
  }
})
it.each([-0.0001, -9007199254741])('unrepresentable signed stock %s rolls back prior writes and cursor', async value => {
  await seed()
  const before = await db.stock.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
  const cursor = await db.syncCursor.findUniqueOrThrow({ where: { connectionId_entityType: { connectionId, entityType: 'generation:availability' } } })
  const input = await generation(undefined, offers(offer('P1', '', -2) + offer('P2', '', value)))
  await expect(importAvailability(input, db)).rejects.toMatchObject({ code: 'source_number_precision' })
  expect(await db.stock.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })).toEqual(before)
  expect(await db.syncCursor.findUniqueOrThrow({ where: { id: cursor.id } })).toEqual(cursor)
  expect((await db.availabilityProjection.findMany({ where: { variant: { storeId } } })).every(p => p.availableQuantity.toString() === '5')).toBe(true)
})
it('negative stock never claims unowned legacy rows or resurrects archived products', async () => {
  await seed()
  const input = await generation(undefined, offers(offer('P1', '', -2), 'true'))
  await db.stock.updateMany({ where: { variant: { storeId, sku: 'P1' } }, data: { sourceConnectionId: null } })
  await expect(importAvailability(input, db)).rejects.toMatchObject({ code: 'stock_source_conflict' })
  await db.productVariant.updateMany({ where: { storeId, sku: 'P1' }, data: { status: 'ARCHIVED' } })
  await expect(importAvailability(input, db)).rejects.toMatchObject({ code: 'product_archived' })
  expect((await db.stock.findFirstOrThrow({ where: { variant: { storeId, sku: 'P1' } } })).available.toString()).toBe('5')
})

const tombstoneCatalog = (ids: string[]) => wrap(`<Каталог СодержитТолькоИзменения="true"><Товары>${ids.map(id => `<Товар Статус="Удален"><Ид>${id}</Ид></Товар>`).join('')}</Товары></Каталог>`)
it('same-generation catalog deletion wins over live offers and counts known and unknown tombstones', async () => {
  await seed()
  const input = await generation(tombstoneCatalog(['P1', 'UNKNOWN']), offers(offer('P1') + offer('UNKNOWN') + offer('P2'), 'true'))
  await expect(importPrices(input, db)).rejects.toMatchObject({ code: 'catalog_generation_not_applied' })
  await expect(importAvailability(input, db)).rejects.toMatchObject({ code: 'catalog_generation_not_applied' })
  await importCatalog(input, db)
  for (const apply of [importPrices, importAvailability]) expect(await apply(input, db)).toMatchObject({ imported: 1, failed: 0, skipped: 2, catalogDeleted: 2, unknownDeleted: 1 })
  expect(await amounts()).toEqual([['P2', 10, bookA]])
  expect(await db.stock.count({ where: { variant: { storeId } } })).toBe(1)
  expect(await db.productVariant.count({ where: { storeId } })).toBe(2)
  expect(await db.productVariant.count({ where: { storeId, status: 'ARCHIVED' } })).toBe(1)
  expect(await db.availabilityProjection.count({ where: { variant: { storeId } } })).toBe(1)
  const another = await generation(undefined, offers(offer('P1'), 'true'))
  await expect(importPrices(another, db)).rejects.toMatchObject({ code: 'product_archived' })
  await expect(importAvailability(another, db)).rejects.toMatchObject({ code: 'product_archived' })
})
it.each(['incomplete', 'wrong-checkpoint', 'wrong-cursor'])('catalog reconciliation refuses %s proof', async mode => {
  const previous = await seed(), input = await generation(tombstoneCatalog(['P1']), offers(offer('P1'), 'true'))
  await importCatalog(input, db)
  if (mode === 'wrong-cursor') await db.syncCursor.updateMany({ where: { connectionId, entityType: 'generation:catalog' }, data: { cursor: previous.generationId } })
  else await db.syncCheckpoint.updateMany({ where: { connectionId, entityType: 'product' }, data: mode === 'incomplete' ? { completed: false } : { generationId: previous.generationId } })
  for (const apply of [importPrices, importAvailability]) await expect(apply(input, db)).rejects.toMatchObject({ code: 'catalog_generation_not_applied' })
})
it('absence from full catalog does not authorize ignoring a conflicting live offer', async () => {
  await seed(); const input = await generation(catalog(['P2']), offers(offer('P1'), 'true'))
  await importCatalog(input, db)
  for (const apply of [importPrices, importAvailability]) await expect(apply(input, db)).rejects.toMatchObject({ code: 'product_archived' })
})
it('unknown explicit offer deletion is an accounted no-op without a catalog file', async () => {
  const input = await generation(undefined, offers('<Предложение Статус="Удален"><Ид>UNKNOWN</Ид></Предложение>', 'true'))
  for (const apply of [importPrices, importAvailability]) expect(await apply(input, db)).toMatchObject({ imported: 0, failed: 0, skipped: 1, unknownDeleted: 1 })
  expect(await db.productVariant.count({ where: { storeId } })).toBe(0)
})
it('batch upserts preserve price IDs and effective dates, stock IDs and reservations', async () => {
  const input = await seed()
  const date = new Date('2026-01-01T00:00:00Z')
  await db.priceEntry.updateMany({ where: { variant: { storeId } }, data: { effectiveFrom: date, effectiveTo: date } })
  await db.stock.updateMany({ where: { variant: { storeId } }, data: { reserved: 2.125 } })
  const beforePrices = await db.priceEntry.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
  const beforeStocks = await db.stock.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
  await importPrices(input, db); await importAvailability(input, db)
  const prices = await db.priceEntry.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
  const stocks = await db.stock.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
  expect(prices.map(({ updatedAt: _at, ...r }) => r)).toEqual(beforePrices.map(({ updatedAt: _at, ...r }) => r))
  expect(stocks.map(({ updatedAt: _at, ...r }) => r)).toEqual(beforeStocks.map(({ updatedAt: _at, ...r }) => r))
})
it('failure after batched writes rolls back values, projections and cursor; a retry succeeds', async () => {
  const ids = Array.from({ length: 1001 }, (_, i) => `B${i}`)
  const initial = await generation(catalog(ids), offers(ids.map(id => offer(id)).join('')))
  await importCatalog(initial, db); await importPrices(initial, db); await importAvailability(initial, db)
  const before = await db.stock.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
  const cursor = await db.syncCursor.findFirstOrThrow({ where: { connectionId, entityType: 'generation:availability' } })
  const projections = await db.availabilityProjection.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })
  const next = await generation(undefined, offers(ids.map(id => offer(id, '', -3)).join('')))
  // Fail at the final cursor write, after staging, upsert, cleanup and projection rebuild.
  const failing = new Proxy(db, { get(target, key) {
    if (key !== '$transaction') return Reflect.get(target, key)
    return (work: (tx: unknown) => Promise<unknown>, options: object) => db.$transaction(tx => work(new Proxy(tx, { get(t, k) {
      if (k === 'syncCursor') return { ...t.syncCursor, upsert: async () => { throw new Error('injected_after_batch') } }
      return Reflect.get(t, k)
    } })), options)
  } })
  await expect(importAvailability(next, failing)).rejects.toThrow('injected_after_batch')
  expect(await db.stock.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })).toEqual(before)
  expect(await db.availabilityProjection.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } })).toEqual(projections)
  expect(await db.syncCursor.findUniqueOrThrow({ where: { id: cursor.id } })).toEqual(cursor)
  expect(await importAvailability(next, db)).toMatchObject({ imported: 1001, failed: 0 })
}, 120_000)

it('bulk projection cleanup with stale empty-table statistics remains bounded and removes absent tuples', async () => {
  const input = await generation(catalog(Array.from({ length: 6000 }, (_, i) => `PROJECTION-${i}`)))
  await importCatalog(input, db)
  const variants = await db.productVariant.findMany({ where: { storeId } })
  // Reproduce the planner state seen after consecutive isolated full replays.
  await db.$executeRaw`ANALYZE "Stock"`; await db.$executeRaw`ANALYZE "AvailabilityProjection"`
  await db.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`
    for (let i = 0; i < variants.length; i += 500) await tx.stock.createMany({ data: variants.slice(i, i + 500).map(v => ({ variantId: v.id, locationId: location, available: 2 })) })
    expect(await projectChannelAvailability(channel, tx)).toBe(6000)
    await tx.stock.deleteMany({ where: { variantId: { in: variants.slice(0, 50).map(v => v.id) }, locationId: location } })
    expect(await projectChannelAvailability(channel, tx)).toBe(5950)
    expect(await tx.availabilityProjection.count({ where: { fulfillmentChannelId: channel } })).toBe(5950)
  }, { timeout: 30_000 })
}, 60_000)
