/** A single idempotent test buyer/order on R22 only; no client 1C access. */
import fs from 'node:fs'
import type { PrismaClient } from '@prisma/client'
import { prisma as db } from '../src/lib/db'
import { getActiveStore } from '../src/lib/store'
import { createRegistrationRequest, approveRegistration } from '../src/lib/registration'
import { createBuyerLocation } from '../src/lib/account/locations'
import { setCartChannel, setCartItem } from '../src/lib/cart/cart'
import { checkout } from '../src/lib/cart/checkout'
import { submitOrder } from '../src/lib/orders/orders'
import { readCommercialSnapshot } from '../src/lib/orders/commercial-snapshot'
import { assertLicenseActive, reloadLicenseState } from '../src/lib/license'
import { resolveSellerRequisites } from '../src/lib/invoices/requisites'
import { grossTax } from '../src/lib/money'
import { sourceCredentials } from '../src/lib/integrations/onec/credentials'
import { openExchangeSession } from '../src/lib/integrations/onec/ledger'
import { querySales } from '../src/lib/integrations/onec/sale'
import { sha256 } from '../src/lib/integrations/onec/storage'

async function main() {
  const recheckIp = process.argv.includes('--ip-recheck')
  const newPoint = process.argv.includes('--new-point-test')
  if (recheckIp && newPoint) throw Error('conflicting_test_modes')
  if (process.argv.slice(2).some(arg => !['--submit', '--ip-recheck', '--new-point-test'].includes(arg))) throw Error('unsupported_argument')
  const outputPrefix = newPoint ? '/tmp/r22-new-point' : recheckIp ? '/tmp/r22-ip-recheck' : '/tmp/r22-new-customer'
  const url = new URL(process.env.DATABASE_URL || '')
  if (process.env.R22_ACCEPTANCE !== '1' || url.hostname !== 'postgres-r22' || url.pathname !== '/axima_r22_acceptance') throw Error('isolated_database_required')
  const store = await getActiveStore()
  const source = await db.integrationConnection.findUniqueOrThrow({ where: { id: process.env.ONEC_EXCHANGE_CONNECTION_ID! } })
  if (store.slug !== 'r22-acceptance' || source.storeId !== store.id || source.environment !== 'TEST' || source.provider !== 'ONE_C' || source.sourceState !== 'ACTIVE' || !source.enabled) throw Error('isolated_source_required')
  assertLicenseActive(reloadLicenseState())
  const input = JSON.parse(fs.readFileSync('/app/r22-config/new-customer-qa/ip-order-input.json', 'utf8'))
  if (input.inn !== '262814584465' || input.legalName !== 'ИП Абросимов Эдуард Вениаминович' || input.kpp || input.email !== 'r22-ip-262814584465@example.invalid') throw Error('buyer_plan_changed')
  const plan = JSON.parse(fs.readFileSync('/app/r22-config/test-order-plan.json', 'utf8'))
  const settings = await db.appSettings.findUniqueOrThrow({ where: { storeId: store.id } })
  if (settings.registrationMode !== 'MANUAL_APPROVAL') throw Error('manual_approval_required')
  const channel = await db.fulfillmentChannel.findUniqueOrThrow({ where: { storeId_code: { storeId: store.id, code: 'r22-test-bank' } } })
  if (!channel.isActive || channel.priceBookId !== plan.priceType.localId || channel.paymentMethod !== 'BANK_TRANSFER') throw Error('channel_changed')
  const seller = resolveSellerRequisites({ channelSellerLegalEntity: channel.sellerLegalEntity, channelInvoiceProfile: channel.invoiceProfile, storeSellerRequisites: settings.sellerRequisites })
  if (!seller || seller.vatRate !== 22 || !seller.vatEnabled || grossTax('270.00', seller).vatAmount !== '48.69') throw Error('seller_tax_changed')
  const price = await db.priceEntry.findUniqueOrThrow({ where: { priceBookId_variantId: { priceBookId: channel.priceBookId!, variantId: plan.line.variantId } } })
  if (!price.amount.equals('270.00') || price.sourceConnectionId !== source.id) throw Error('price_changed')
  // User explicitly authorized this local-only test staff fixture.
  // No usable password or login token is created; the old suspended user stays unchanged.
  const actor = await db.user.upsert({ where: { storeId_email: { storeId: store.id, email: 'r22-new-customer-moderator@example.invalid' } },
    create: { storeId: store.id, email: 'r22-new-customer-moderator@example.invalid', name: 'Тестовый модератор нового покупателя', passwordHash: '!disabled', role: 'STAFF', status: 'ACTIVE' }, update: {} })
  if (actor.role !== 'STAFF' || actor.status !== 'ACTIVE' || actor.passwordHash !== '!disabled') throw Error('test_moderator_mismatch')
  const existingCustomer = await db.customer.findUnique({ where: { storeId_inn: { storeId: store.id, inn: input.inn } } })
  if (existingCustomer && (existingCustomer.legalName !== input.legalName || existingCustomer.kpp !== null)) throw Error('existing_buyer_mismatch')
  let buyer = await db.user.findUnique({ where: { storeId_email: { storeId: store.id, email: input.email } } })
  let request = await db.registrationRequest.findFirst({ where: { storeId: store.id, email: input.email }, orderBy: { createdAt: 'desc' } })
  if (!buyer) {
    request ??= await createRegistrationRequest({ ...input, contactName: 'Тест обмена — ИП Абросимов' })
    if (request.status !== 'PENDING' || request.inn !== input.inn || request.legalName !== input.legalName || request.kpp !== null) throw Error('registration_mismatch')
    await approveRegistration(request.id, { actor })
    buyer = await db.user.findUniqueOrThrow({ where: { storeId_email: { storeId: store.id, email: input.email } } })
  }
  if (!buyer.customerId || buyer.role !== 'BUYER' || buyer.status !== 'ACTIVE' || buyer.storeId !== store.id) throw Error('buyer_mismatch')
  if (!request || request.createdUserId && request.createdUserId !== buyer.id) throw Error('registration_link_mismatch')
  if (await db.externalReference.count({ where: { connectionId: source.id, entityType: 'customer', entityId: buyer.customerId } })) throw Error('manual_customer_mapping_forbidden')
  const point = newPoint
    ? { name: 'Тестовый новый филиал — НЕ ОТГРУЖАТЬ', city: 'Евпатория', address: 'ул. Тестовая, д. 8 (ТЕСТ — НЕ ДОСТАВЛЯТЬ)' }
    : recheckIp
    ? { name: 'м-н "Дымок", (рын. Натали), ИП Абросимов', city: 'Евпатория', address: 'ул. Интернациональная 130' }
    : { name: 'Тестовая точка — без отгрузки', city: 'ТЕСТ', address: 'Техническая проверка обмена — НЕ ДОСТАВЛЯТЬ' }
  let location = await db.customerLocation.findFirst({ where: { customerId: buyer.customerId, name: point.name } })
  location ??= await createBuyerLocation(buyer, point)
  if (location.city !== point.city || location.address !== point.address) throw Error('location_mismatch')
  const key = newPoint ? 'r22-new-point-262814584465-v1' : recheckIp ? 'r22-ip-recheck-262814584465' : 'r22-new-customer-262814584465'
  const receipt = await db.checkoutReceipt.findUnique({ where: { key }, include: { order: true } })
  const pending = await db.orderExport.count({ where: { storeId: store.id, status: { in: ['PENDING', 'RETRYING', 'AWAITING_ACK', 'PROCESSING'] }, ...(receipt ? { orderId: { not: receipt.orderId } } : {}) } })
  if (pending) throw Error('other_orders_pending')
  let order = receipt?.order
  if (!order) {
    await setCartChannel(buyer, channel.id); await setCartItem(buyer, plan.line.variantId, 1)
    order = await checkout(buyer, { deliveryLocationId: location.id, idempotencyKey: key, comment: newPoint ? 'ТЕСТ — НЕ ОТГРУЖАТЬ, НЕ ОПЛАЧИВАТЬ, НЕ ДОСТАВЛЯТЬ. Проверка нового адреса доставки для прежнего ИП. Адрес вымышленный.' : 'ТЕСТ — НЕ ОТГРУЖАТЬ. Проверка поиска существующего ИП по ИНН без ручного GUID. Не оплачивать и не доставлять.' })
  }
  const items = await db.orderItem.findMany({ where: { orderId: order.id } })
  if (order.storeId !== store.id || order.customerId !== buyer.customerId || order.userId !== buyer.id || !order.total.equals('270.00') || items.length !== 1 || items[0].variantId !== plan.line.variantId || !items[0].quantity.equals(1)) throw Error('order_mismatch')
  if (process.argv.includes('--submit') && order.status === 'DRAFT') order = await submitOrder(buyer, order.id)
  let xmlSha256: string | null = null
  if (process.argv.includes('--submit')) {
    const terms = readCommercialSnapshot(order.commercialSnapshot, order)
    if (!terms || terms.buyer.inn !== input.inn || terms.buyer.kpp !== null || terms.buyer.legalName !== input.legalName || terms.tax.amount !== '48.69') throw Error('snapshot_mismatch')
    const credentials = await sourceCredentials(), credential = credentials.find(c => c.connectionId === source.id)!, secret = process.env.NEXTAUTH_SECRET!
    const session = await openExchangeSession(store.id, credential, secret)
    let xml = ''
    const rollback = new Error('preview_rollback')
    const client = { $transaction: async (work: (tx: unknown) => Promise<string>, options: object) => {
      try { await db.$transaction(async tx => { xml = await work(tx); throw rollback }, options) } catch (error) { if (error !== rollback) throw error }
      return xml
    } } as unknown as PrismaClient
    try { await querySales({ storeId: store.id, sessionId: session.id, credentials, secret }, client) }
    finally { await db.onecExchangeSession.update({ where: { id: session.id }, data: { closedAt: new Date() } }) }
    const record = await db.orderExport.findUniqueOrThrow({ where: { orderId: order.id } })
    if (record.attempts === 0) {
      if (!xml.includes('<Ид>' + order.id + '</Ид>') || !xml.includes('<ИНН>262814584465</ИНН>') || !xml.includes(input.legalName) || !xml.includes('<Ид>site-')) throw Error('xml_preview_mismatch')
      if (recheckIp || newPoint) {
        const buyerXml = xml.split('<Контрагент>')[1]?.split('</Контрагент>')[0] ?? ''
        if (!buyerXml.includes('<ПолноеНаименование>' + input.legalName + '</ПолноеНаименование>') || buyerXml.includes('<ОфициальноеНаименование>') || buyerXml.includes('<КПП>')) throw Error('ip_requisites_not_fixed')
      }
      if (newPoint && !xml.includes('<Адрес><Представление>' + point.city + ', ' + point.address + '</Представление></Адрес>')) throw Error('new_point_address_missing')
      fs.writeFileSync(outputPrefix + '-preview.xml', xml, { mode: 0o600 })
      xmlSha256 = sha256(xml)
    }
  }
  const record = await db.orderExport.findUnique({ where: { orderId: order.id } })
  const identity = await db.onecSaleCustomerIdentity.findUnique({ where: { connectionId_customerId: { connectionId: source.id, customerId: buyer.customerId } } })
  if (newPoint) {
    const grant = await db.userDeliveryPointGrant.findUnique({ where: { userId_locationId: { userId: buyer.id, locationId: location.id } } })
    if (grant?.origin !== 'SELF_CREATED' || grant.assignedById !== buyer.id) throw Error('self_created_point_grant_missing')
  }
  const report = { delivery: point, scenario: newPoint ? 'NEW_POINT' : recheckIp ? 'IP_RECHECK' : 'NEW_CUSTOMER', checkedAt: new Date().toISOString(), orderId: order.id, number: order.number, status: order.status, total: order.total.toFixed(2), vat: '48.69', buyer: input.legalName, inn: input.inn, kpp: null, item: items[0].productName, quantity: '1', exportStatus: record?.status ?? null, attempts: record?.attempts ?? 0, manualMapping: false, xmlSha256, previewRolledBack: xmlSha256 !== null, customerIdentityOrigin: identity?.origin ?? null, invoiceCount: await db.invoice.count({ where: { orderId: order.id } }) }
  fs.writeFileSync(outputPrefix + '-order.json', JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(report))
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error.message); process.exitCode = 1 })
