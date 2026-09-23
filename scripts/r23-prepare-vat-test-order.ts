/** Isolated test only: preserve the accepted R22-00003 and prepare a separate VAT case. */
import fs from 'node:fs'
import { prisma as db } from '../src/lib/db'
import { setCartChannel, setCartItem } from '../src/lib/cart/cart'
import { checkout } from '../src/lib/cart/checkout'
import { submitOrder } from '../src/lib/orders/orders'
import { assertLicenseActive, reloadLicenseState } from '../src/lib/license'
import { recordAudit } from '../src/lib/audit'
async function main() {
 const url = new URL(process.env.DATABASE_URL || '')
 if (process.env.R22_ACCEPTANCE !== '1' || url.hostname !== 'postgres-r22' || url.pathname !== '/axima_r22_acceptance') throw Error('isolated_database_required')
 const plan = JSON.parse(fs.readFileSync('/app/r22-config/test-order-plan.json','utf8'))
 const source = await db.integrationConnection.findUniqueOrThrow({where: {id: plan.sourceConnectionId}, include: {store: true}})
 if (source.store.slug !== 'r22-acceptance' || source.environment !== 'TEST' || source.id !== process.env.ONEC_EXCHANGE_CONNECTION_ID || source.provider !== 'ONE_C') throw Error('test_source_required')
 assertLicenseActive(reloadLicenseState())
 const old = await db.order.findUniqueOrThrow({where: {id: 'cmubmtk70000a1317s2p5a5vk'}, include: {export: {include: {onecDelivery: true}}, user: true}})
 if (old.storeId !== source.storeId || old.number !== 'R22-00003' || old.status !== 'SUBMITTED' || old.export?.status !== 'DELIVERED' || !old.export.onecDelivery?.receivedAt) throw Error('accepted_test_order_state_changed')
 if (await db.checkoutReceipt.findUnique({where: {key: 'r23-vat-line-test'}})) throw Error('vat_test_already_exists_inspect_it')
 const actor = await db.user.findUniqueOrThrow({where: {storeId_email: {storeId: source.storeId, email: 'r22-acceptance@localhost'}}})
 await setCartChannel(old.user, old.fulfillmentChannelId); await setCartItem(old.user, plan.line.variantId, 1)
 const next = await checkout(old.user, {deliveryLocationId: old.deliveryLocationId, comment: plan.comment + '; отдельная проверка НДС в строке товара 22%, включён в стоимость', idempotencyKey: 'r23-vat-line-test'})
 if (!next.total.equals('270')) throw Error('test_price_changed')
 await db.$transaction(async tx => {
  await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${source.id} FOR UPDATE`
  const current = await tx.integrationConnection.findUniqueOrThrow({where: {id: source.id}})
  const config = current.config as Record<string, any>
  await tx.integrationConnection.update({where: {id: source.id}, data: {config: {...config, saleImport: {enabled: true, mode: 'REVIEW'}}, exchangeRevision: {increment: 1}}})
  await recordAudit(tx, {storeId: source.storeId, actor, action: 'OnecSaleCaptureEnabled', targetType: 'IntegrationConnection', targetId: source.id, metadata: {mode: 'REVIEW', purpose: 'Verify actual UT 11.4 status dialect'}})
 })
 const order = await submitOrder(old.user, next.id), exp = await db.orderExport.findUniqueOrThrow({where: {orderId: next.id}})
 const previous = await db.order.findUniqueOrThrow({where: {id: old.id}, include: {export: {include: {onecDelivery: true}}}})
 if (previous.export?.onecDelivery?.sha256 !== old.export.onecDelivery.sha256 || previous.export?.status !== old.export.status || previous.status !== old.status) throw Error('accepted_order_changed')
 const report = {at: new Date().toISOString(), number: order.number, orderId: order.id, status: order.status, exportStatus: exp.status, attempts: exp.attempts, total: order.total.toString(), priorNumber: old.number, priorOrderPreserved: true, priorDeliveryHash: old.export.onecDelivery.sha256, saleImport: 'PENDING_REVIEW_ONLY'}
 fs.writeFileSync('/tmp/r23-vat-order.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report))
}
main().finally(() => db.$disconnect()).catch(e => {console.error(e.message); process.exitCode=1})
