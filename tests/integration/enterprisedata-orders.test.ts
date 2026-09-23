import { saveSourceMapping } from '@/lib/integrations/mappings'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkout } from '@/lib/cart/checkout'
import { setCartChannel, setCartItem } from '@/lib/cart/cart'
import { submitOrder, cancelOrder } from '@/lib/orders/orders'
import { configureOrderDelivery } from '@/lib/integrations/order-delivery'
import { prepareSiteOrder } from '@/lib/integrations/enterprisedata/site-orders'
import { siteTransport } from '@/lib/integrations/enterprisedata/site-transport'
import { openFileTransport } from '@/lib/integrations/enterprisedata/http-files'
import { digest, envelope, inspectMessage } from '@/lib/integrations/enterprisedata/message'
import { readXmlZip, writeXmlZip } from '@/lib/integrations/enterprisedata/zip'
import type { SessionUser } from '@/lib/authz'
const activeStore = vi.hoisted(() => ({ id: '' }))
vi.mock('@/lib/store', () => ({ getActiveStore: async () => activeStore }))
const db = new PrismaClient()
let storeId: string, channelId: string, variantId: string, productId: string, deliveryId: string, warehouseId: string, bookId: string, connectionId: string
let user: SessionUser
const seller = { companyName: 'ТЕСТ — НЕ ДЛЯ ОПЛАТЫ', inn: '7712345678', vatEnabled: true, vatRate: 22 }
const profile = { enabled: true, format: 'ENTERPRISEDATA_1_20', currency: 'RUB', timeZone: 'Europe/Moscow', numberPrefix: 'AX' }
async function draft() { await setCartChannel(user, channelId); await setCartItem(user, variantId, 2); return checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: randomUUID(), comment: 'Accepted note' }, db) }
beforeEach(async () => {
  storeId = (await db.store.create({ data: { slug: 'r22-sale-' + randomUUID(), name: 'R20 isolated test' } })).id
  await db.appSettings.create({ data: { storeId, invoicePrefix: 'R20-' + storeId.slice(-6), sellerRequisites: seller } })
  bookId = (await db.priceBook.create({ data: { storeId, code: 'original-book', name: 'Original price book', isDefault: true } })).id
  warehouseId = (await db.inventoryLocation.create({ data: { storeId, code: 'original-warehouse', name: 'Original warehouse' } })).id
  channelId = (await db.fulfillmentChannel.create({ data: { storeId, code: 'original-channel', name: 'Original channel', inventoryLocationId: warehouseId, paymentMethod: 'BANK_TRANSFER', priceBookId: bookId } })).id
  productId = (await db.product.create({ data: { storeId, canonicalName: 'Original product', status: 'ACTIVE' } })).id
  variantId = (await db.productVariant.create({ data: { storeId, productId, sku: 'ORIGINAL', sourceSku: 'ARTICLE', packaging: 'box', status: 'ACTIVE' } })).id
  await db.priceEntry.create({ data: { priceBookId: bookId, variantId, amount: 122 } })
  const customer = await db.customer.create({ data: { storeId, displayName: 'Original buyer', legalName: 'Original buyer LLC', inn: '7798765432', kpp: '771201001' } })
  deliveryId = (await db.customerLocation.create({ data: { customerId: customer.id, name: 'Original delivery', address: 'Original street', city: 'Original city' } })).id
  const buyer = await db.user.create({ data: { storeId, customerId: customer.id, email: 'buyer@r20.test', name: 'Buyer', passwordHash: 'test', role: 'BUYER', status: 'ACTIVE' } })
  user = { id: buyer.id, storeId, customerId: customer.id, priceGroupId: null, role: 'BUYER', status: 'ACTIVE', name: buyer.name, email: buyer.email }
  connectionId = (await db.integrationConnection.create({ data: { storeId, provider: 'ONE_C', name: 'R20 source', enabled: true, sourceState: 'ACTIVE', environment: 'TEST', config: { saleExport: profile } } })).id
  activeStore.id = storeId
  const entries = [
    ['product', productId, '11111111-1111-4111-8111-111111111111', { baseUnit: { code: '796', name: 'Штука' } }],
    ['customer', user.customerId, '22222222-2222-4222-8222-222222222222', {}],
    ['location', warehouseId, '33333333-3333-4333-8333-333333333333', { warehouseAddress: { city: 'Test city', address: 'Warehouse street 1' } }],
    ['priceType', bookId, 'price-external', {}],
    ['seller', channelId, '44444444-4444-4444-8444-444444444444', seller],
    ['channel', channelId, channelId, { channelId, warehouseExternalId: '33333333-3333-4333-8333-333333333333', priceTypeExternalId: 'price-external', sellerExternalId: '44444444-4444-4444-8444-444444444444' }],
  ] as const
  for (const [entityType, entityId, externalId, sourceData] of entries) await db.externalReference.create({ data: { connectionId, entityType, entityId: entityId!, externalId, sourceData } })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await db.order.deleteMany({ where: { storeId } })
  await db.integrationError.deleteMany({ where: { storeId } })
  await db.store.delete({ where: { id: storeId } })
})




const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })))
afterAll(() => db.$disconnect())
const peer = { from: '55555555-5555-4555-8555-555555555555', to: '66666666-6666-4666-8666-666666666666', plan: 'СинхронизацияДанныхЧерезУниверсальныйФормат' }
const q = (v: Record<string, string>) => new URLSearchParams(v)
const peerQ = { NodeCode: peer.from, ExchangePlanName: peer.plan }
async function submitted() { const order = await draft(); await submitOrder(user, order.id, db); return order }
function transport() {
  const dir = mkdtempSync(join(tmpdir(), 'ed-site-integration-')); dirs.push(dir)
  const files = openFileTransport(dir, () => peer), binding = { storeId, connectionId }
  const bridge = siteTransport(files, binding, db)
  const call = async (op: string, values: Record<string, string>, body?: Buffer) => bridge.handle(op, q(values), body)
  const output = async () => {
    const out = JSON.parse((await call('UploadData', peerQ)).body.toString())
    const read = JSON.parse((await call('PrepareGetFile', { FileID: out.FileID, BlockSize: '1024' })).body.toString())
    const xml = readXmlZip((await call('GetFilePart', { SessionID: read.SessionID, PartNumber: '1' })).body as Buffer)
    return { fileId: out.FileID, xml, message: inspectMessage(xml) }
  }
  const upload = async (no: number, received: number) => {
    const session = randomUUID(), xml = envelope({ ...peer, messageNo: no, receivedNo: received }, [], new Date().toISOString())
    await call('PutFilePart', { SessionID: session, PartNumber: '1' }, writeXmlZip(Buffer.from(xml)))
    await call('SaveFileFromParts', { SessionID: session, PartCount: '1' })
    return { ...peerQ, FileID: session }
  }
  return { files, call, output, upload, binding }
}
it('exports accepted site terms, replays exact bytes, delivers on protocol ACK and allocates distinct 11-character numbers', async () => {
  const first = await submitted(), t = transport()
  const [a,b] = await Promise.all([t.output(), t.output()])
  expect(a.fileId).toBe(b.fileId); expect(a.xml).toEqual(b.xml)
  expect(a.xml.toString()).toContain('<Номер>AX000000001</Номер>')
  expect(a.xml.toString()).toContain('<АдресДоставки>Original city, Original street</АдресДоставки>')
  expect(a.xml.toString()).toContain('<СуммаНДС>44.00</СуммаНДС>')
  expect(a.xml.toString()).toContain('<Сумма>244.00</Сумма>')
  expect((await db.orderExport.findUniqueOrThrow({ where: { orderId: first.id } })).status).toBe('AWAITING_ACK')
  expect((await cancelOrder(user, first.id, db)).requested).toBe(true)
  await expect(configureOrderDelivery(storeId, connectionId, { enabled: false }, user, db)).rejects.toThrow('sale_receipts_pending')
  const incoming = await t.upload(1,1); await t.call('DownloadData', incoming)
  const record = await db.orderExport.findUniqueOrThrow({ where: { orderId: first.id } })
  expect(record.status).toBe('DELIVERED'); expect(record.confirmedAt).toBeNull(); expect(record.externalId).toBeNull()
  expect((await db.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('SUBMITTED')
  await submitted(); const second = await t.output()
  expect(second.xml.toString()).toContain('<Номер>AX000000002</Номер>')
  expect(second.message.confirmation.receivedNo).toBe(1)
  expect(await db.enterpriseDataDelivery.count({ where: { connectionId } })).toBe(2)
})
it('recovers the DB-to-file and file-to-DB crash windows without resending a new order identity', async () => {
  const order = await submitted(), binding = { storeId, connectionId }
  const prepared = await prepareSiteOrder(binding, peer.to, db)
  const t = transport(), out = await t.output()
  expect(out.xml.toString()).toContain(prepared!.documentId)
  expect(await db.enterpriseDataDelivery.count({ where: { connectionId } })).toBe(1)
  const incoming = await t.upload(1,1)
  t.files.handle('DownloadData', q(incoming)) // Simulate process death before updating the DB receipt.
  expect((await db.orderExport.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe('AWAITING_ACK')
  await siteTransport(t.files, binding, db).handle('UploadData', q(peerQ))
  expect((await db.orderExport.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe('DELIVERED')
  expect(await db.enterpriseDataDelivery.count({ where: { connectionId } })).toBe(1)
})
it('rejects foreign nodes, inactive sources, and publication of a cancelled pending order', async () => {
  const order = await submitted(), t = transport()
  await expect(t.call('UploadData', { ...peerQ, NodeCode: randomUUID() })).rejects.toThrow('ed_file_peer_mismatch')
  expect(await db.enterpriseDataDelivery.count({ where: { connectionId } })).toBe(0)
  await t.output()
  await db.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } })
  await expect(t.output()).rejects.toThrow('ed_order_not_exportable')
  await db.integrationConnection.update({ where: { id: connectionId }, data: { enabled: false, sourceState: 'PREPARING' } })
  await expect(t.output()).rejects.toThrow('ed_source_inactive')
  await expect(siteTransport(t.files, { connectionId, storeId: 'other-store' }, db).handle('UploadData', q(peerQ))).rejects.toThrow('ed_source_inactive')
})
it('isolates invalid product mappings and preserves accepted delivery data after point edits', async () => {
  const order = await submitted(), t = transport()
  await db.customerLocation.update({ where: { id: deliveryId }, data: { address: 'Changed later' } })
  await db.externalReference.updateMany({ where: { connectionId, entityType: 'product' }, data: { externalId: 'not-a-guid' } })
  expect((await t.output()).message.objects).toHaveLength(0)
  expect((await db.orderExport.findUniqueOrThrow({ where: { orderId: order.id } })).lastError).toBe('ed_mapping_invalid')
  expect(await db.enterpriseDataDelivery.count({ where: { connectionId } })).toBe(0)
})
it('gives a new approved customer a stable source-scoped UUID without sharing another customer point', async () => {
  await db.externalReference.deleteMany({ where: { connectionId, entityType: 'customer' } })
  await submitted(); const t = transport(), first = await t.output()
  const identity = await db.externalReference.findFirstOrThrow({ where: { connectionId, entityType: 'edCustomerIdentity' } })
  expect(identity.sourceData).toMatchObject({ origin: 'WEBSITE' })
  expect(first.xml.toString()).toContain('<Ссылка>' + identity.externalId + '</Ссылка>')
  const incoming = await t.upload(1,1);await t.call('DownloadData', incoming)
  await submitted(); const next = await t.output()
  expect(next.xml.toString()).toContain('<Ссылка>' + identity.externalId + '</Ссылка>')
  expect(await db.externalReference.count({ where: { connectionId, entityType: 'edCustomerIdentity' } })).toBe(1)
})

it('allows a verified ED counterparty mapping without rewriting a legacy CommerceML identity, then freezes it', async () => {
  await db.onecSaleCustomerIdentity.create({ data: { connectionId, customerId: user.customerId!, xmlId: 'site-legacy-cml', origin: 'WEBSITE', inn: '7798765432', kpp: '771201001' } })
  const externalId = '77777777-7777-4777-8777-777777777777'
  await saveSourceMapping(storeId, connectionId, { entityType: 'edCustomer', entityId: user.customerId!, externalId }, user, db)
  await submitted(); const out = await transport().output()
  expect(out.xml.toString()).toContain('<Контрагент><Ссылка>' + externalId + '</Ссылка>')
  expect((await db.onecSaleCustomerIdentity.findUniqueOrThrow({ where: { connectionId_customerId: { connectionId, customerId: user.customerId! } } })).xmlId).toBe('site-legacy-cml')
  await expect(saveSourceMapping(storeId, connectionId, { entityType: 'edCustomer', entityId: user.customerId!, externalId: randomUUID() }, user, db)).rejects.toThrow('ed_customer_identity_changed')
})

it.each(['TEST', 'PRODUCTION'] as const)('exports the accepted point in comments without a processor or partner mapping in %s', async environment => {
  await db.integrationConnection.update({ where: { id: connectionId }, data: { environment, config: { saleExport: { ...profile, partnerAssignment: 'TEST_PROCESSOR_V1' } } } })
  await submitted()
  const first = await prepareSiteOrder({ storeId, connectionId }, peer.to, db)
  expect(first).not.toBeNull()
  expect(first!.xml).not.toContain('AXIMA.Partner/1|')
  expect(first!.xml).toContain('Точка: Original delivery')
  expect(first!.xml).toContain('Оплата: безналичная')
  expect(first!.xml).toContain('<Контрагент><Ссылка>22222222-2222-4222-8222-222222222222</Ссылка>')
  expect(first!.xml).toContain('<Цена>122.00</Цена>')
  expect(first!.xml).toContain('<Сумма>244.00</Сумма>')
  expect(first!.xml).toContain('<СуммаНДС>44.00</СуммаНДС>')
  expect(first!.xml).toContain('<АдресДоставки>Original city, Original street</АдресДоставки>')
  await db.customerLocation.update({ where: { id: deliveryId }, data: { name: 'Renamed later', address: 'Changed later' } })
  const replay = await prepareSiteOrder({ storeId, connectionId }, peer.to, db)
  expect(replay!.xml).toBe(first!.xml)
  expect(replay!.sha256).toBe(first!.sha256)
})
it('refuses enabling the retired processor without changing existing settings', async () => {
  const before = await db.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
  await expect(configureOrderDelivery(storeId, connectionId, { ...profile, partnerAssignment: 'TEST_PROCESSOR_V1' }, user, db)).rejects.toThrow('ed_partner_processor_retired')
  const after = await db.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
  expect(after.config).toEqual(before.config)
  expect(after.exchangeRevision).toBe(before.exchangeRevision)
  expect(await configureOrderDelivery(storeId, connectionId, profile, user, db)).toEqual(profile)
})

// A deployment may happen after the old adapter committed an outbox but before ACK.
it('replays a previously prepared processor packet unchanged after retiring the processor', async () => {
  await submitted()
  const binding = { storeId, connectionId }
  const prepared = await prepareSiteOrder(binding, peer.to, db)
  const marker = ['AXIMA.Partner/1', connectionId, prepared!.documentId, prepared!.number,
    '33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222',
    '44444444-4444-4444-8444-444444444444'].join('|')
  const legacyXml = prepared!.xml.replace('<Комментарий>', '<Комментарий>' + marker + '\n')
  await db.enterpriseDataDelivery.update({ where: { id: prepared!.id }, data: { xml: legacyXml, sha256: digest(legacyXml) } })
  const replay = await prepareSiteOrder(binding, peer.to, db)
  expect(replay!.xml).toBe(legacyXml)
  expect(replay!.sha256).toBe(digest(legacyXml))
  expect(replay!.documentId).toBe(prepared!.documentId)
  expect((await db.enterpriseDataSequence.findUniqueOrThrow({ where: { connectionId } })).value).toBe(1)
  expect(await db.enterpriseDataDelivery.count({ where: { connectionId } })).toBe(1)
})
