import { assertCapability } from '@/lib/capabilities'
import { z } from 'zod'
import type { Prisma, PrismaClient, OrderStatus } from '@prisma/client'
import { prisma as db } from '@/lib/db'
import { readCommercialSnapshot, type CommercialSnapshot } from '@/lib/orders/commercial-snapshot'
import { EXPORTABLE_ORDER_STATUSES } from '@/lib/orders/state'
import { SellerRequisitesSchema } from '@/lib/invoices/requisites'
import { fingerprint } from '@/lib/catalog/normalize'
import { ChannelMappingSchema } from '../mappings'
import { SaleUnitSchema } from '../onec/sale-document'
import { IntegrationInputError } from '../errors'
import { enterpriseDataProfile } from './profile'
import { digest } from './message'
import { documentUuid, renderWebsiteOrder, type OrderReferences } from './order'
type Tx = Prisma.TransactionClient
export type SiteBinding = { storeId: string; connectionId: string }
const guid = z.string().uuid().refine(v => !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v))
const bad = (code: string): never => { throw new IntegrationInputError(code) }
export async function requireEdSource(binding: SiteBinding, client: PrismaClient | Tx = db) {
  const source = await client.integrationConnection.findFirst({ where: { id: binding.connectionId, storeId: binding.storeId, provider: 'ONE_C', enabled: true, sourceState: 'ACTIVE' } })
  if (!source) return bad('ed_source_inactive')
  if (!['TEST', 'PRODUCTION'].includes(source.environment)) return bad('ed_source_environment_required')
  return { source, profile: enterpriseDataProfile(source.config) }
}
async function references(tx: Tx, t: CommercialSnapshot, binding: SiteBinding, namespace: string): Promise<Omit<OrderReferences, 'evidenceSha256'>> {
  if (!await tx.customerLocation.findFirst({ where: { id: t.delivery.id, customerId: t.buyer.id, customer: { storeId: binding.storeId } } })) bad('ed_delivery_customer_mismatch')
  const ids = [t.buyer.id, t.channel.id, t.warehouse.id, t.pricing.bookId, ...t.lines.map(l => l.productId ?? '')]
  const rows = await tx.externalReference.findMany({ where: { connectionId: binding.connectionId, entityId: { in: ids } } })
  const get = (entityType: string, entityId: string) => {
    const found = rows.filter(r => r.entityType === entityType && r.entityId === entityId)
    if (found.length !== 1) return bad('ed_' + entityType + '_mapping_required')
    return found[0]
  }
  const seller = get('seller', t.channel.id), warehouse = get('location', t.warehouse.id), book = get('priceType', t.pricing.bookId)
  const channel = ChannelMappingSchema.parse(get('channel', t.channel.id).sourceData)
  const legal = SellerRequisitesSchema.parse(seller.sourceData)
  if (fingerprint(legal) !== fingerprint(t.seller) || channel.channelId !== t.channel.id || channel.sellerExternalId !== seller.externalId || channel.warehouseExternalId !== warehouse.externalId || channel.priceTypeExternalId !== book.externalId) bad('ed_channel_mapping_mismatch')
  guid.parse(seller.externalId); guid.parse(warehouse.externalId)
  const variants = await tx.productVariant.findMany({ where: { storeId: binding.storeId, id: { in: t.lines.map(l => l.variantId ?? '') } } })
  const products = t.lines.map(l => {
    const variant = variants.find(v => v.id === l.variantId)
    if (!variant || variant.productId !== l.productId || !variant.isDefault || variant.unitsPerPack !== 1) return bad('ed_variant_mapping_required')
    const mapping = get('product', variant.productId), unit = SaleUnitSchema.parse((mapping.sourceData as { baseUnit?: unknown } | null)?.baseUnit)
    return { variantId: variant.id, ref: guid.parse(mapping.externalId), unitCode: unit.code, unitName: unit.name }
  })
  const mappedBuyer = rows.find(r => r.entityType === 'edCustomer' && r.entityId === t.buyer.id) ?? rows.find(r => r.entityType === 'customer' && r.entityId === t.buyer.id)
  const prior = await tx.externalReference.findUnique({ where: { connectionId_entityType_entityId: { connectionId: binding.connectionId, entityType: 'edCustomerIdentity', entityId: t.buyer.id } } })
  const buyerId = mappedBuyer ? guid.parse(mappedBuyer.externalId) : prior?.externalId ?? documentUuid(namespace, 'customer:' + t.buyer.id)
  if (prior) {
    const frozen = z.object({ inn: z.string(), kpp: z.string().nullable() }).parse(prior.sourceData)
    if (prior.externalId !== buyerId || frozen.inn !== t.buyer.inn || frozen.kpp !== t.buyer.kpp) bad('ed_customer_identity_changed')
  } else {
    await tx.externalReference.create({ data: { connectionId: binding.connectionId, entityType: 'edCustomerIdentity', entityId: t.buyer.id, externalId: buyerId, sourceData: { inn: t.buyer.inn, kpp: t.buyer.kpp, origin: mappedBuyer ? 'ERP_MAPPING' : 'WEBSITE' } } })
  }
  return { organization: seller.externalId, warehouse: warehouse.externalId, counterparty: buyerId, products: Array.from(new Map(products.map(p => [p.variantId, p])).values()) }
}
/** DB outbox commits before a packet is published. A restart resumes the same delivery. */
export async function prepareSiteOrder(binding: SiteBinding, namespace: string, client: PrismaClient = db) {
  assertCapability('commerce-core')

  guid.parse(namespace)
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${binding.connectionId} FOR UPDATE`
    const { source, profile } = await requireEdSource(binding, tx)
    const candidates = await tx.orderExport.findMany({ where: { ...binding, status: { in: ['PENDING', 'RETRYING', 'AWAITING_ACK'] }, externalId: null, availableAt: { lte: new Date() }, order: { status: { in: EXPORTABLE_ORDER_STATUSES } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20 })
    for (const candidate of candidates) {
      const [order] = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM "Order" WHERE id = ${candidate.orderId} AND "storeId" = ${binding.storeId} FOR UPDATE`
      if (!order || !EXPORTABLE_ORDER_STATUSES.includes(order.status as OrderStatus)) continue
      await tx.$queryRaw`SELECT id FROM "OrderExport" WHERE id = ${candidate.id} FOR UPDATE`
      const record = await tx.orderExport.findUniqueOrThrow({ where: { id: candidate.id } })
      if (!['PENDING', 'RETRYING', 'AWAITING_ACK'].includes(record.status)) continue
      const previous = await tx.enterpriseDataDelivery.findUnique({ where: { exportId: record.id } })
      if (previous) {
        if (previous.connectionId !== binding.connectionId || digest(previous.xml) !== previous.sha256) bad('ed_delivery_corrupt')
        return previous
      }
      if (record.status === 'AWAITING_ACK' || await tx.onecSaleDelivery.findUnique({ where: { exportId: record.id } })) bad('ed_other_transport_delivery_exists')
      if (record.attempts >= record.maxAttempts) continue
      try {
        const entity = await tx.order.findUniqueOrThrow({ where: { id: order.id } }), terms = readCommercialSnapshot(entity.commercialSnapshot, entity)
        if (!terms || terms.connectionId !== binding.connectionId) bad('ed_snapshot_source_mismatch')
        const refs = await references(tx, terms!, binding, namespace)
        const sequence = await tx.enterpriseDataSequence.upsert({ where: { connectionId: binding.connectionId }, create: { connectionId: binding.connectionId, namespace, prefix: profile.numberPrefix }, update: {} })
        if (sequence.namespace !== namespace || sequence.prefix !== profile.numberPrefix) bad('ed_sequence_identity_changed')
        if (sequence.value >= 999999999) bad('ed_number_exhausted')
        const count = await tx.enterpriseDataSequence.update({ where: { connectionId: binding.connectionId }, data: { value: { increment: 1 } } })
        const number = count.prefix + String(count.value).padStart(9, '0'), documentId = documentUuid(namespace, 'order:' + order.id)
        const xml = renderWebsiteOrder(terms, refs, documentId, number, source.environment === 'TEST')
        const delivery = await tx.enterpriseDataDelivery.create({ data: { exportId: record.id, connectionId: binding.connectionId, documentId, number, xml, sha256: digest(xml) } })
        await tx.orderExport.update({ where: { id: record.id }, data: { status: 'AWAITING_ACK', attempts: { increment: 1 }, lastError: null, leaseToken: null, leaseExpiresAt: null } })
        return delivery
      } catch (error) {
        // Do not catch database/transaction failures: their writes must roll back.
        if (!(error instanceof IntegrationInputError || error instanceof z.ZodError || error instanceof Error && error.name === 'EnterpriseDataError')) throw error
        const code = error instanceof z.ZodError ? 'ed_mapping_invalid' : error.message
        await tx.orderExport.update({ where: { id: record.id }, data: { status: 'FAILED', attempts: { increment: 1 }, lastError: code } })
        await tx.integrationError.create({ data: { storeId: binding.storeId, connectionId: binding.connectionId, code: 'ED_ORDER_EXPORT_FAILED', message: code, context: { orderId: order.id } } })
      }
    }
    return null
  }, { timeout: 30000 })
}
export async function acknowledgeSiteOrders(binding: SiteBinding, receipts: Array<{ deliveryId: string; documentHash: string }>, client: PrismaClient = db) {
  if (!receipts.length) return
  await client.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${binding.connectionId} FOR UPDATE`
    await requireEdSource(binding, tx)
    const rows = await tx.enterpriseDataDelivery.findMany({ where: { id: { in: receipts.map(r => r.deliveryId) }, connectionId: binding.connectionId, export: { storeId: binding.storeId } }, select: { id: true, sha256: true, receivedAt: true, exportId: true, export: { select: { orderId: true } } } })
    if (rows.length !== new Set(receipts.map(r => r.deliveryId)).size) bad('ed_receipt_delivery_mismatch')
    const byId = new Map(rows.map(r => [r.id, r]))
    for (const receipt of receipts) {
      const row = byId.get(receipt.deliveryId)
      if (!row || row.sha256 !== receipt.documentHash) bad('ed_receipt_delivery_mismatch')
      if (row!.receivedAt) continue
      const payload = await tx.enterpriseDataDelivery.findUniqueOrThrow({ where: { id: row!.id }, select: { xml: true } })
      if (digest(payload.xml) !== row!.sha256) bad('ed_delivery_corrupt')
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${row!.export.orderId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM "OrderExport" WHERE id = ${row!.exportId} FOR UPDATE`
      const receivedAt = new Date()
      await tx.enterpriseDataDelivery.update({ where: { id: row!.id }, data: { receivedAt } })
      await tx.orderExport.updateMany({ where: { id: row!.exportId, connectionId: binding.connectionId, status: 'AWAITING_ACK' }, data: { status: 'DELIVERED', submittedAt: receivedAt } })
    }
  }, { timeout: 30000 })
}

export async function requirePendingDeliveries(binding: SiteBinding, ids: string[], client: PrismaClient = db) {
  if (!ids.length) return
  const count = await client.enterpriseDataDelivery.count({ where: { id: { in: ids }, connectionId: binding.connectionId, export: { storeId: binding.storeId, status: 'AWAITING_ACK', order: { status: { in: EXPORTABLE_ORDER_STATUSES } } } } })
  if (count !== ids.length) bad('ed_order_not_exportable')
}
