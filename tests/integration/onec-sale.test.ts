import { setBuyerDeliveryPoints } from '@/lib/account/location-access'
import { createRegistrationRequest, approveRegistration } from '@/lib/registration'
import { readCommercialSnapshot } from '@/lib/orders/commercial-snapshot'
import { saleCustomerIdentity } from '@/lib/integrations/onec/sale-customer'
import { receiveSaleFile } from '@/lib/integrations/onec/sale-inbox'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { checkout } from '@/lib/cart/checkout'
import { setCartChannel, setCartItem } from '@/lib/cart/cart'
import { submitOrder, cancelOrder } from '@/lib/orders/orders'
import { issueInvoice } from '@/lib/invoices/invoices'
import { runDueOrderExports, retryOrderExport } from '@/lib/integrations/order-export'
import { querySales, acknowledgeSales } from '@/lib/integrations/onec/sale'
import { openExchangeSession } from '@/lib/integrations/onec/ledger'
import { recoverExpiredWork } from '@/lib/integrations/recovery'
import { saveSourceMapping, listSourceMappings } from '@/lib/integrations/mappings'
import { configureOrderDelivery } from '@/lib/integrations/order-delivery'
import { handleOnecExchange } from '@/lib/integrations/onec/http'
import type { SessionUser } from '@/lib/authz'
const activeStore = vi.hoisted(() => ({ id: '' }))
vi.mock('@/lib/store', () => ({ getActiveStore: async () => activeStore }))
const db = new PrismaClient()
let storeId: string, channelId: string, variantId: string, productId: string, deliveryId: string, warehouseId: string, bookId: string, connectionId: string
let user: SessionUser
const seller = { companyName: 'ТЕСТ — НЕ ДЛЯ ОПЛАТЫ', inn: '7712345678', vatEnabled: true, vatRate: 22 }
const profile = { enabled: true, format: 'COMMERCEML_2_10', currency: 'RUB', timeZone: 'Europe/Moscow' }
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
    ['product', productId, 'product-external', { baseUnit: { code: '796', name: 'Штука' } }],
    ['customer', user.customerId, 'customer-external', {}],
    ['location', warehouseId, 'warehouse-external', { warehouseAddress: { city: 'Test city', address: 'Warehouse street 1' } }],
    ['priceType', bookId, 'price-external', {}],
    ['seller', channelId, 'seller-external', seller],
    ['channel', channelId, channelId, { channelId, warehouseExternalId: 'warehouse-external', priceTypeExternalId: 'price-external', sellerExternalId: 'seller-external' }],
  ] as const
  for (const [entityType, entityId, externalId, sourceData] of entries) await db.externalReference.create({ data: { connectionId, entityType, entityId: entityId!, externalId, sourceData } })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await db.order.deleteMany({ where: { storeId } })
  await db.integrationError.deleteMany({ where: { storeId } })
  await db.store.delete({ where: { id: storeId } })
})



async function authority() {
  const credentials = [{ connectionId, user: 'r22-local', pass: 'r22-local-test-only' }]
  const session = await openExchangeSession(storeId, credentials[0], 'r22-local-session-secret', db)
  return { storeId, sessionId: session.id, credentials, secret: 'r22-local-session-secret' }
}
async function submitted() { const order = await draft(); await submitOrder(user, order.id, db); return order }
async function record(orderId: string) { return db.orderExport.findUniqueOrThrow({ where: { orderId } }) }
async function updateConfig(config: object) { await db.integrationConnection.update({ where: { id: connectionId }, data: { config } }) }

it('serializes accepted terms and real mapped identities, preserves exact decimal amounts and persists identical replay', async () => {
  await db.priceEntry.updateMany({ where: { variantId }, data: { amount: '9999999999999999.99' } })
  await setCartChannel(user, channelId); await setCartItem(user, variantId, 1)
  const order = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: randomUUID(), comment: 'A < B & C "quote" 😀' }, db)
  await submitOrder(user, order.id, db)
  await db.product.update({ where: { id: productId }, data: { canonicalName: 'Changed product' } })
  await db.customer.update({ where: { id: user.customerId! }, data: { legalName: 'Changed buyer' } })
  await db.customerLocation.update({ where: { id: deliveryId }, data: { city: 'Later city', address: 'Later destination' } })
  const auth = await authority(), xml = await querySales(auth, db)
  expect(xml).toContain('<Ид>product-external</Ид>')
  expect(xml).toContain('<Ид>warehouse-external</Ид>')
  expect(xml).toContain('<АдресноеПоле><Тип>Город</Тип><Значение>Test city</Значение></АдресноеПоле>')
  expect(xml).toContain('<Ид>customer-external</Ид>')
  expect(xml).toContain('<Ид>seller-external</Ид>')
  expect(xml).toContain('<Сумма>9999999999999999.99</Сумма>')
  expect(xml).toContain('<Сумма>1803278688524590.16</Сумма>')
  expect(xml).toContain('A &lt; B &amp; C &quot;quote&quot; 😀')
  expect(xml).toContain('<Адрес><Представление>Original city, Original street</Представление></Адрес>')
  expect(xml).not.toContain('Later destination')
  expect(xml).toContain('Original buyer LLC'); expect(xml).not.toContain('Changed product')
  expect(xml).not.toContain('<Ид>ORIGINAL</Ид>')
  expect((await record(order.id))).toMatchObject({ status: 'AWAITING_ACK', attempts: 1, externalId: null, confirmedAt: null })
  await db.externalReference.updateMany({ where: { connectionId, entityType: 'customer' }, data: { externalId: 'later-customer' } })
  expect(await querySales(auth, db)).toBe(xml)
  const next = await querySales(await authority(), db)
  expect(next).toContain('customer-external'); expect(next).not.toContain('later-customer')
  const delivery = await db.onecSaleDelivery.findUniqueOrThrow({ where: { exportId: (await record(order.id)).id } })
  expect(next).toContain(delivery.xml)
  if (process.env.R22_EVIDENCE_DIR) await fs.writeFile(path.join(process.env.R22_EVIDENCE_DIR, 'r22-sale-example.xml'), xml)
})

it('success acknowledges only the session batch, never creates an ERP ID or permits an invoice', async () => {
  const first = await submitted(), auth = await authority()
  await querySales(auth, db)
  const later = await submitted()
  await acknowledgeSales(auth, db); await acknowledgeSales(auth, db)
  expect(await record(first.id)).toMatchObject({ status: 'DELIVERED', externalId: null, confirmedAt: null })
  expect((await record(later.id)).status).toBe('PENDING')
  expect((await db.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('SUBMITTED')
  expect(await db.externalReference.count({ where: { connectionId, entityType: 'order' } })).toBe(0)
  await expect(issueInvoice({ storeId, orderId: first.id, actor: user }, db)).rejects.toThrow()
  expect(await querySales(await authority(), db)).not.toContain('<Ид>' + first.id + '</Ид>')
  await expect(acknowledgeSales(await authority(), db)).rejects.toMatchObject({ code: 'sale_query_required' })
})

it('push worker does not claim or exhaust a pull export, including with a provider override', async () => {
  const order = await submitted(), submit = vi.fn()
  expect(await runDueOrderExports({ storeId, resolveProvider: () => ({ provider: 'ONE_C', healthcheck: async () => ({ ok: true }), pullProducts: async () => ({ items: [] }), submitOrder: submit }) }, db)).toEqual([])
  expect(submit).not.toHaveBeenCalled()
  expect(await record(order.id)).toMatchObject({ status: 'PENDING', attempts: 0 })
})

it('missing product mapping rejects the whole batch atomically without fallback to SKU or another source', async () => {
  const order = await submitted()
  await db.externalReference.deleteMany({ where: { connectionId, entityType: 'product' } })
  const other = await db.integrationConnection.create({ data: { storeId, provider: 'ONE_C', name: 'other', environment: 'TEST' } })
  await db.externalReference.create({ data: { connectionId: other.id, entityType: 'product', entityId: productId, externalId: 'foreign-product' } })
  await expect(querySales(await authority(), db)).rejects.toMatchObject({ code: 'sale_product_mapping_required' })
  expect(await record(order.id)).toMatchObject({ attempts: 0, status: 'PENDING' })
  expect(await db.onecSaleDelivery.count({ where: { connectionId } })).toBe(0)
  expect(await db.onecSaleBatch.count({ where: { session: { connectionId } } })).toBe(0)
})

it('rolls back a previously serialized order when a later order in the batch is invalid', async () => {
  const first = await submitted()
  const other = await db.productVariant.create({ data: { storeId, productId, sku: 'UNMAPPED', isDefault: false } })
  await db.priceEntry.create({ data: { priceBookId: bookId, variantId: other.id, amount: 122 } })
  await setCartChannel(user, channelId); await setCartItem(user, other.id, 1)
  const second = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: randomUUID() }, db)
  await submitOrder(user, second.id, db)
  await expect(querySales(await authority(), db)).rejects.toMatchObject({ code: 'sale_variant_mapping_ambiguous' })
  expect(await record(first.id)).toMatchObject({ attempts: 0, status: 'PENDING' })
  expect(await db.onecSaleDelivery.count({ where: { connectionId } })).toBe(0)
})

it('requires source units and rejects changed seller/channel mappings', async () => {
  await submitted()
  await db.externalReference.updateMany({ where: { connectionId, entityType: 'product' }, data: { sourceData: {} } })
  await expect(querySales(await authority(), db)).rejects.toMatchObject({ code: 'sale_product_unit_required' })
  await db.externalReference.updateMany({ where: { connectionId, entityType: 'seller' }, data: { sourceData: { ...seller, inn: '9999999999' } } })
  await expect(querySales(await authority(), db)).rejects.toMatchObject({ code: 'sale_channel_mapping_mismatch' })
})

it('before claim cancellation excludes the order; after claim cancellation requires the manager', async () => {
  const before = await submitted()
  expect((await cancelOrder(user, before.id, db)).requested).toBe(false)
  expect(await querySales(await authority(), db)).not.toContain('<Документ>')
  const after = await submitted()
  await querySales(await authority(), db)
  expect((await cancelOrder(user, after.id, db)).requested).toBe(true)
  expect((await db.order.findUniqueOrThrow({ where: { id: after.id } })).status).toBe('SUBMITTED')
})

it('concurrent cancel and query have one winner and never export a self-cancelled order', async () => {
  const order = await submitted(), auth = await authority()
  const [xml, cancellation] = await Promise.all([querySales(auth, db), cancelOrder(user, order.id, db)])
  expect(xml.includes('<Ид>' + order.id + '</Ид>')).toBe(cancellation.requested)
  expect((await record(order.id)).attempts).toBe(cancellation.requested ? 1 : 0)
})

it('parallel sessions and concurrent retries create one immutable delivery', async () => {
  const order = await submitted(), auth = await authority(), other = await authority()
  const xml = await Promise.all([querySales(auth, db), querySales(other, db), querySales(auth, db)])
  expect(xml[0]).toBe(xml[2])
  expect(await db.onecSaleDelivery.count({ where: { connectionId } })).toBe(1)
  expect((await record(order.id)).attempts).toBe(1)
  const delivery = await db.onecSaleDelivery.findUniqueOrThrow({ where: { exportId: (await record(order.id)).id } })
  await expect(db.onecSaleDelivery.update({ where: { id: delivery.id }, data: { xml: '<changed/>' } })).rejects.toThrow('onec_sale_payload_immutable')
})

it('manual retry and lease recovery leave awaiting/received deliveries intact', async () => {
  const order = await submitted(), auth = await authority()
  await querySales(auth, db); await retryOrderExport(order.id, db)
  await recoverExpiredWork(db, 100, storeId)
  expect(await record(order.id)).toMatchObject({ status: 'AWAITING_ACK', attempts: 1 })
  await acknowledgeSales(auth, db); await retryOrderExport(order.id, db)
  expect((await record(order.id)).status).toBe('DELIVERED')
})

it('fails closed for revoked sessions, wrong store, disabled source and missing export profile', async () => {
  await submitted(); const auth = await authority()
  await expect(querySales({ ...auth, storeId: 'foreign-store' }, db)).rejects.toMatchObject({ code: 'session_source_changed' })
  await updateConfig({})
  await expect(querySales(auth, db)).rejects.toMatchObject({ code: 'sale_export_not_configured' })
  await updateConfig({ saleExport: profile })
  await db.integrationConnection.update({ where: { id: connectionId }, data: { exchangeRevision: { increment: 1 } } })
  await expect(querySales(auth, db)).rejects.toMatchObject({ code: 'session_source_changed' })
  await db.integrationConnection.update({ where: { id: connectionId }, data: { enabled: false, sourceState: 'PREPARING' } })
  await expect(querySales(await authority(), db)).rejects.toThrow()
})

it('does not replay a batch after the order becomes rejected', async () => {
  const order = await submitted(), auth = await authority()
  await querySales(auth, db)
  await db.order.update({ where: { id: order.id }, data: { status: 'REJECTED' } })
  await expect(querySales(auth, db)).rejects.toMatchObject({ code: 'sale_batch_order_not_exportable' })
})

it('configures only supported sources and preserves unrelated settings with a revision bump', async () => {
  await updateConfig({ brandGroups: ['g'] })
  const previous = await db.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
  expect(await configureOrderDelivery(storeId, connectionId, profile, user, db)).toEqual(profile)
  const after = await db.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
  expect(after.config).toEqual({ brandGroups: ['g'], saleExport: profile }); expect(after.exchangeRevision).toBe(previous.exchangeRevision + 1)
  await submitted(); await querySales(await authority(), db)
  await expect(configureOrderDelivery(storeId, connectionId, { enabled: false }, user, db)).rejects.toMatchObject({ code: 'sale_receipts_pending' })
  const unsupported = await db.integrationConnection.create({ data: { storeId, provider: 'MOYSKLAD', name: 'unsupported' } })
  await expect(configureOrderDelivery(storeId, unsupported.id, profile, user, db)).rejects.toMatchObject({ code: 'order_delivery_unsupported' })
})

it('HTTP checkauth/init/query/success uses the source cookie and XML content type; inbound receipt requires an explicit source profile', async () => {
  await submitted()
  vi.stubEnv('NEXTAUTH_SECRET', 'r22-http-secret')
  vi.stubEnv('ONEC_EXCHANGE_CONNECTION_ID', connectionId)
  vi.stubEnv('ONEC_EXCHANGE_USER', 'r22-local')
  vi.stubEnv('ONEC_EXCHANGE_PASSWORD', 'r22-local-test-only')
  vi.stubEnv('ONEC_SOURCES_FILE', '')
  const url = 'http://localhost/api/integrations/1c/exchange?type=sale&mode='
  const unauthorized = await handleOnecExchange(new Request(url + 'query'))
  expect(unauthorized.status).toBe(401)
  const checked = await handleOnecExchange(new Request(url + 'checkauth', { headers: { authorization: 'Basic ' + Buffer.from('r22-local:r22-local-test-only').toString('base64') } }))
  expect(checked.status).toBe(200)
  const body = (await checked.text()).split('\n'), headers = { cookie: body[1] + '=' + body[2] }
  expect(await (await handleOnecExchange(new Request(url + 'init', { headers }))).text()).toContain('zip=no')
  const response = await handleOnecExchange(new Request(url + 'query', { headers }))
  expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8')
  expect(await response.text()).toContain('<Документ>')
  expect(await (await handleOnecExchange(new Request(url + 'success', { headers }))).text()).toBe('success')
  const inbound = await handleOnecExchange(new Request(url + 'file&filename=orders.xml', { method: 'POST', headers, body: '<КоммерческаяИнформация/>' }))
  expect(inbound.status).toBe(503); expect(await inbound.text()).toContain('sale_ack_import_not_configured')
  await enableInbox()
  const received = await handleOnecExchange(new Request(url + 'file&filename=orders.xml', {method: 'POST', headers, body: inboundXml('site-order').toString()}))
  expect(received.status).toBe(200); expect(await received.text()).toBe('success')
  expect(await db.onecSaleInbox.count({where: {connectionId, status: 'PENDING_REVIEW'}})).toBe(1)
  const getFile = await handleOnecExchange(new Request(url + 'file&filename=orders.xml', {headers}))
  expect(getFile.status).toBe(405)
  const partial = await handleOnecExchange(new Request(url + 'file&filename=orders.xml', {method: 'POST', headers, body: '<КоммерческаяИнформация>'}))
  expect(partial.status).toBe(400)
  expect(await db.onecSaleInbox.count({where: {connectionId}})).toBe(1)

})
afterAll(() => db.$disconnect())

it('unsupported push provider fails explicitly without a successful or repeatedly retried export', async () => {
  const order = await submitted()
  await db.integrationConnection.update({ where: { id: connectionId }, data: { provider: 'MOYSKLAD' } })
  const result = await runDueOrderExports({ storeId }, db)
  expect(result).toHaveLength(1); expect(result[0].status).toBe('FAILED')
  expect(result[0].message).toContain('MOYSKLAD')
  expect(await record(order.id)).toMatchObject({ status: 'FAILED', externalId: null })
})

it('blocks absent warehouse address before persisting an attempt, delivery or batch', async () => {
  const order = await submitted()
  await db.externalReference.updateMany({ where: { connectionId, entityType: 'location' }, data: { sourceData: {} } })
  const auth = await authority()
  await expect(querySales(auth, db)).rejects.toMatchObject({ code: 'sale_warehouse_address_required' })
  expect(await record(order.id)).toMatchObject({ status: 'PENDING', attempts: 0 })
  expect(await db.onecSaleDelivery.count({ where: { connectionId } })).toBe(0)
  expect(await db.onecSaleBatch.count({ where: { sessionId: auth.sessionId } })).toBe(0)
})

it('saves a location address and exposes it without changing a previously issued document', async () => {
  const order = await submitted(), auth = await authority()
  const xml = await querySales(auth, db)
  const warehouseAddress = { city: 'New city', address: 'New warehouse street' }
  await saveSourceMapping(storeId, connectionId, { entityType: 'location', externalId: 'warehouse-external', entityId: warehouseId, warehouseAddress }, user, db)
  const saved = await db.externalReference.findUniqueOrThrow({ where: { connectionId_entityType_externalId: { connectionId, entityType: 'location', externalId: 'warehouse-external' } } })
  expect(saved.sourceData).toEqual({ warehouseAddress })
  const listed = await listSourceMappings(storeId, connectionId, db)
  expect(listed.mappings.find(m => m.entityType === 'location')?.details).toEqual({ warehouseAddress })
  expect(await querySales(auth, db)).toBe(xml)
  expect(await record(order.id)).toMatchObject({ status: 'AWAITING_ACK', attempts: 1 })
  await expect(saveSourceMapping(storeId, connectionId, { entityType: 'priceType', externalId: 'price-external', entityId: bookId, warehouseAddress }, user, db)).rejects.toThrow()
})


const inboundXml = (id: string) => Buffer.from('<КоммерческаяИнформация ВерсияСхемы="2.07"><Документ><Ид>' + id + '</Ид><ЗначенияРеквизитов><ЗначениеРеквизита><Наименование>Статус заказа</Наименование><Значение>На согласовании</Значение></ЗначениеРеквизита></ЗначенияРеквизитов></Документ></КоммерческаяИнформация>')
const enableInbox = () => updateConfig({saleExport: profile, saleImport: {enabled: true, mode: 'REVIEW'}})
it('durably receives a real-shaped answer without authorizing an invoice or changing accepted terms', async () => {
  await enableInbox(); const order = await submitted(), auth = await authority()
  await querySales(auth, db); await acknowledgeSales(auth, db)
  const before = await db.order.findUniqueOrThrow({where: {id: order.id}})
  const result = await receiveSaleFile(auth, 'orders.xml', inboundXml(order.id), db)
  expect(result.status).toBe('PENDING_REVIEW')
  const row = await db.onecSaleInbox.findUniqueOrThrow({where: {id: result.id}})
  expect(row.xml).toBe(inboundXml(order.id).toString()); expect(row.documentCount).toBe(1)
  const after = await db.order.findUniqueOrThrow({where: {id: order.id}})
  expect(after.commercialSnapshot).toEqual(before.commercialSnapshot); expect(after.status).toBe('SUBMITTED')
  expect(await record(order.id)).toMatchObject({status: 'DELIVERED', externalId: null, confirmedAt: null})
  await expect(issueInvoice({storeId, orderId: order.id, actor: user}, db)).rejects.toThrow()
  await expect(db.onecSaleInbox.update({where: {id: result.id}, data: {xml: '<changed/>'}})).rejects.toThrow('onec_sale_inbox_immutable')
})
it('deduplicates concurrent and new-session replay by source and content', async () => {
  await enableInbox(); const a = await authority(), b = await authority(), xml = inboundXml('site-order')
  const results = await Promise.all([receiveSaleFile(a, 'orders.xml', xml, db), receiveSaleFile(b, 'repeated.xml', xml, db)])
  expect(results[0].id).toBe(results[1].id); expect(results.filter(r => r.duplicate)).toHaveLength(1)
  expect(await db.onecSaleInbox.count({where: {connectionId}})).toBe(1)
  expect(await db.auditEntry.count({where: {storeId, action: 'OnecSaleFileReceived'}})).toBe(1)
  await receiveSaleFile(a, 'orders.xml', inboundXml('another-order'), db)
  expect(await db.onecSaleInbox.count({where: {connectionId}})).toBe(2)
})
it('rejects disabled, cross-store, closed and revoked sessions without writing a receipt', async () => {
  const auth = await authority(), xml = inboundXml('site-order')
  await expect(receiveSaleFile(auth, 'orders.xml', xml, db)).rejects.toMatchObject({code: 'sale_ack_import_not_configured'})
  await enableInbox()
  await expect(receiveSaleFile({...auth, storeId: 'other-store'}, 'orders.xml', xml, db)).rejects.toMatchObject({code: 'session_source_changed'})
  await db.onecExchangeSession.update({where: {id: auth.sessionId}, data: {closedAt: new Date()}})
  await expect(receiveSaleFile(auth, 'orders.xml', xml, db)).rejects.toThrow()
  const next = await authority(); await db.integrationConnection.update({where: {id: connectionId}, data: {exchangeRevision: {increment: 1}}})
  await expect(receiveSaleFile(next, 'orders.xml', xml, db)).rejects.toMatchObject({code: 'session_source_changed'})
  expect(await db.onecSaleInbox.count({where: {connectionId}})).toBe(0)
})


it('registers and moderates a new buyer, then exports without a manually supplied ERP GUID', async () => {
  const request = await createRegistrationRequest({ email: 'new-buyer@r22.test', password: 'local-test-only-123', contactName: 'Новый покупатель', legalName: 'ООО Новый клиент', inn: '7701234567', kpp: '770101001' })
  expect(request.status).toBe('PENDING')
  expect(await db.user.count({ where: { storeId, email: request.email } })).toBe(0)
  const approved = await approveRegistration(request.id, { actor: null })
  const buyer = await db.user.findUniqueOrThrow({ where: { id: approved.createdUserId! } })
  user = { ...user, id: buyer.id, customerId: buyer.customerId, email: buyer.email, name: buyer.name }
  deliveryId = (await db.customerLocation.create({ data: { customerId: buyer.customerId!, name: 'Магазин', city: 'Москва', address: 'Тестовая улица, 1' } })).id
  const moderator = await db.user.create({ data: { storeId, email: 'point-moderator@r22.test', name: 'Moderator', passwordHash: '!disabled', role: 'STAFF' } })
  await setBuyerDeliveryPoints(buyer.id, [deliveryId], moderator)
  const first = await submitted(), auth = await authority()
  const xml = await querySales(auth, db)
  const identity = await db.onecSaleCustomerIdentity.findUniqueOrThrow({ where: { connectionId_customerId: { connectionId, customerId: buyer.customerId! } } })
  expect(identity.origin).toBe('WEBSITE')
  expect(identity.xmlId).toMatch(/^site-[a-f0-9]{32}$/)
  expect(xml).toContain('<Ид>' + identity.xmlId + '</Ид>')
  expect(xml).toContain('<ИНН>7701234567</ИНН><КПП>770101001</КПП>')
  expect(await db.externalReference.count({ where: { connectionId, entityType: 'customer', entityId: buyer.customerId! } })).toBe(0)
  expect(await querySales(auth, db)).toBe(xml)
  await acknowledgeSales(auth, db)
  const second = await submitted()
  const repeated = await querySales(await authority(), db)
  expect(repeated).toContain('<Ид>' + second.id + '</Ид>')
  expect(repeated).not.toContain('<Ид>' + first.id + '</Ид>')
  expect(repeated).toContain('<Ид>' + identity.xmlId + '</Ид>')
  expect(await db.onecSaleCustomerIdentity.count({ where: { connectionId, customerId: buyer.customerId! } })).toBe(1)
  expect(await record(first.id)).toMatchObject({ status: 'DELIVERED', externalId: null, confirmedAt: null })
})

it('reuses the moderated customer and its existing mapping for a second account with the same INN', async () => {
  const customerId = user.customerId!
  const request = await createRegistrationRequest({ email: 'existing-buyer@r22.test', password: 'local-test-only-123', contactName: 'Коллега', legalName: 'Original buyer LLC', inn: '7798765432', kpp: '771201001' })
  const approved = await approveRegistration(request.id, { actor: null })
  expect(approved.createdCustomerId).toBe(customerId)
  expect(await db.customer.count({ where: { storeId, inn: '7798765432' } })).toBe(1)
  const buyer = await db.user.findUniqueOrThrow({ where: { id: approved.createdUserId! } })
  user = { ...user, id: buyer.id, email: buyer.email }
  const moderator = await db.user.create({ data: { storeId, email: 'point-moderator@r22.test', name: 'Moderator', passwordHash: '!disabled', role: 'STAFF' } })
  await setBuyerDeliveryPoints(buyer.id, [deliveryId], moderator)
  await submitted()
  expect(await querySales(await authority(), db)).toContain('<Ид>customer-external</Ид>')
  expect(await db.onecSaleCustomerIdentity.findUniqueOrThrow({ where: { connectionId_customerId: { connectionId, customerId } } })).toMatchObject({ origin: 'ERP_MAPPING', xmlId: 'customer-external' })
})

it('pins one website identity across concurrent sessions and ignores customer mappings from another source', async () => {
  await db.externalReference.deleteMany({ where: { connectionId, entityType: 'customer' } })
  const other = await db.integrationConnection.create({ data: { storeId, provider: 'ONE_C', name: 'other-source', environment: 'TEST' } })
  await db.externalReference.create({ data: { connectionId: other.id, entityType: 'customer', entityId: user.customerId!, externalId: 'foreign-customer' } })
  await submitted()
  const a = await authority(), b = await authority()
  const responses = await Promise.all([querySales(a, db), querySales(b, db)])
  const identity = await db.onecSaleCustomerIdentity.findUniqueOrThrow({ where: { connectionId_customerId: { connectionId, customerId: user.customerId! } } })
  for (const xml of responses) { expect(xml).toContain(identity.xmlId); expect(xml).not.toContain('foreign-customer') }
  expect(await db.onecSaleCustomerIdentity.count({ where: { connectionId } })).toBe(1)
  expect(await db.onecSaleDelivery.count({ where: { connectionId } })).toBe(1)
})

it('rolls back the new buyer identity with an invalid batch', async () => {
  await db.externalReference.deleteMany({ where: { connectionId, entityType: 'customer' } })
  const order = await submitted()
  await db.externalReference.updateMany({ where: { connectionId, entityType: 'product' }, data: { sourceData: {} } })
  await expect(querySales(await authority(), db)).rejects.toMatchObject({ code: 'sale_product_unit_required' })
  expect(await db.onecSaleCustomerIdentity.count({ where: { connectionId } })).toBe(0)
  expect(await record(order.id)).toMatchObject({ status: 'PENDING', attempts: 0 })
})

it('blocks ambiguous mappings and freezes accepted buyer requisites for future exports', async () => {
  await expect(db.externalReference.create({ data: { connectionId, entityType: 'customer', entityId: user.customerId!, externalId: 'duplicate-customer' } })).rejects.toMatchObject({ code: 'P2002' })
  await submitted()
  const auth = await authority(), original = await querySales(auth, db)
  await acknowledgeSales(auth, db)
  await db.customer.update({ where: { id: user.customerId! }, data: { kpp: '770101999' } })
  await submitted()
  await expect(querySales(await authority(), db)).rejects.toMatchObject({ code: 'sale_customer_requisites_changed' })
  expect(await querySales(auth, db)).toBe(original)
})

it('prevents remapping an already exported buyer or assigning its identity to another customer', async () => {
  await submitted(); await querySales(await authority(), db)
  await expect(saveSourceMapping(storeId, connectionId, { entityType: 'customer', entityId: user.customerId!, externalId: 'changed-id' }, user, db)).rejects.toMatchObject({ code: 'sale_customer_identity_changed' })
  const other = await db.customer.create({ data: { storeId, displayName: 'Other', legalName: 'Other', inn: '7701000001' } })
  await expect(saveSourceMapping(storeId, connectionId, { entityType: 'customer', entityId: other.id, externalId: 'customer-external' }, user, db)).rejects.toMatchObject({ code: 'sale_customer_identity_changed' })
  await expect(saveSourceMapping(storeId, connectionId, { entityType: 'customer', entityId: user.customerId!, externalId: 'customer-external' }, user, db)).resolves.toMatchObject({ externalId: 'customer-external' })
  await db.externalReference.updateMany({ where: { connectionId, entityType: 'customer' }, data: { externalId: 'bypassed-edit' } })
  await submitted()
  await expect(querySales(await authority(), db)).rejects.toMatchObject({ code: 'sale_customer_identity_changed' })
})

it('keeps a persisted XML identity when a mapping is removed and enforces immutability in the database', async () => {
  const order = await submitted(), auth = await authority()
  await querySales(auth, db); await acknowledgeSales(auth, db)
  await db.externalReference.deleteMany({ where: { connectionId, entityType: 'customer' } })
  await submitted()
  expect(await querySales(await authority(), db)).toContain('<Ид>customer-external</Ид>')
  await expect(db.onecSaleCustomerIdentity.update({ where: { connectionId_customerId: { connectionId, customerId: user.customerId! } }, data: { xmlId: 'changed' } })).rejects.toThrow('onec_sale_customer_identity_immutable')
  const terms = readCommercialSnapshot((await db.order.findUniqueOrThrow({ where: { id: order.id } })).commercialSnapshot, { id: order.id, storeId })!
  await expect(db.$transaction(tx => saleCustomerIdentity(tx, { ...terms, storeId: 'another-store' }, connectionId))).rejects.toMatchObject({ code: 'sale_customer_not_found' })
})


it('backfills the sent identity from legacy XML rather than a later mapping, including escaped characters', async () => {
  await db.externalReference.updateMany({ where: { connectionId, entityType: 'customer' }, data: { externalId: 'customer&old' } })
  await submitted(); const auth = await authority(); await querySales(auth, db); await acknowledgeSales(auth, db)
  await db.externalReference.deleteMany({ where: { connectionId, entityType: 'customer' } })
  const createSql = await fs.readFile('prisma/migrations/20260922040000_onec_sale_customer_identity/migration.sql', 'utf8')
  const insert = createSql.slice(createSql.indexOf('INSERT INTO "OnecSaleCustomerIdentity"')).trim().replace(/;$/, ' WHERE d."connectionId" = $1')
  const repairSql = await fs.readFile('prisma/migrations/20260922040100_onec_sale_customer_legacy_xml_text/migration.sql', 'utf8')
  const repair = repairSql.slice(repairSql.indexOf('UPDATE "OnecSaleCustomerIdentity"'), repairSql.indexOf('CREATE TRIGGER'))
  await db.$transaction(async tx => {
    await tx.onecSaleCustomerIdentity.deleteMany({ where: { connectionId } })
    await tx.$executeRawUnsafe(insert, connectionId)
    await tx.$executeRawUnsafe('DROP TRIGGER "OnecSaleCustomerIdentity_guard" ON "OnecSaleCustomerIdentity"')
    await tx.$executeRawUnsafe(repair)
    await tx.$executeRawUnsafe('CREATE TRIGGER "OnecSaleCustomerIdentity_guard" BEFORE INSERT OR UPDATE ON "OnecSaleCustomerIdentity" FOR EACH ROW EXECUTE FUNCTION guard_onec_sale_customer_identity()')
  })
  const identity = await db.onecSaleCustomerIdentity.findUniqueOrThrow({ where: { connectionId_customerId: { connectionId, customerId: user.customerId! } } })
  expect(identity).toMatchObject({ xmlId: 'customer&old', origin: 'LEGACY_XML' })
  await submitted()
  expect(await querySales(await authority(), db)).toContain('<Ид>customer&amp;old</Ид>')
})

it('keeps website identities source-scoped and rejects cross-store rows in the database', async () => {
  await db.externalReference.deleteMany({ where: { connectionId, entityType: 'customer' } })
  const order = await submitted(); await querySales(await authority(), db)
  const terms = readCommercialSnapshot((await db.order.findUniqueOrThrow({ where: { id: order.id } })).commercialSnapshot, { id: order.id, storeId })!
  const other = await db.integrationConnection.create({ data: { storeId, provider: 'ONE_C', name: 'isolated source', environment: 'TEST' } })
  const otherId = await db.$transaction(tx => saleCustomerIdentity(tx, { ...terms, connectionId: other.id }, other.id))
  const original = await db.onecSaleCustomerIdentity.findUniqueOrThrow({ where: { connectionId_customerId: { connectionId, customerId: user.customerId! } } })
  expect(otherId).not.toBe(original.xmlId)
  const foreignStore = await db.store.create({ data: { slug: 'r22-foreign-' + randomUUID(), name: 'Foreign' } })
  try {
    const customer = await db.customer.create({ data: { storeId: foreignStore.id, displayName: 'Foreign', legalName: 'Foreign', inn: '7710000001' } })
    await expect(db.onecSaleCustomerIdentity.create({ data: { connectionId, customerId: customer.id, xmlId: 'foreign', origin: 'WEBSITE', inn: customer.inn } })).rejects.toThrow('onec_sale_customer_identity_source_mismatch')
  } finally { await db.store.delete({ where: { id: foreignStore.id } }) }
})
