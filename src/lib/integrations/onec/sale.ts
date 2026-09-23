import { assertCapability } from '@/lib/capabilities'
import type { Prisma, PrismaClient } from '@prisma/client'
import { WarehouseAddressSchema } from '../warehouse-address'
import { saleCustomerIdentity } from './sale-customer'
import { prisma as db } from '@/lib/db'
import { readCommercialSnapshot } from '@/lib/orders/commercial-snapshot'
import { EXPORTABLE_ORDER_STATUSES } from '@/lib/orders/state'
import { fingerprint } from '@/lib/catalog/normalize'
import { SellerRequisitesSchema } from '@/lib/invoices/requisites'
import { ChannelMappingSchema } from '@/lib/integrations/mappings'
import { authenticateSession, type SessionAuthority } from './ledger'
import { ExchangeError, sha256 } from './storage'
import { saleDocument, saleEnvelope, saleProfile, SaleUnitSchema, type SaleReferences } from './sale-document'

type Tx = Prisma.TransactionClient
async function authorized(tx: Tx, authority: SessionAuthority) {
  const initial = await tx.onecExchangeSession.findUnique({ where: { id: authority.sessionId }, select: { connectionId: true } })
  if (!initial) throw new ExchangeError('session_expired_or_unknown', 401)
  // Same source lock as mapping edits, activation and credential/session changes.
  await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${initial.connectionId} FOR UPDATE`
  const session = await authenticateSession(authority, tx)
  if (session.connection.sourceState !== 'ACTIVE' || !session.connection.enabled) throw new ExchangeError('source_not_active', 503)
  return { session, profile: saleProfile(session.connection.config) }
}
async function documentFor(tx: Tx, orderId: string, storeId: string, connectionId: string, profile: ReturnType<typeof saleProfile>) {
  const order = await tx.order.findFirstOrThrow({ where: { id: orderId, storeId } })
  const terms = readCommercialSnapshot(order.commercialSnapshot, order)
  if (!terms) throw new ExchangeError('sale_snapshot_required')
  if (terms.connectionId !== connectionId) throw new ExchangeError('sale_snapshot_source_mismatch')
  const identities = [terms.buyer.id, terms.channel.id, terms.warehouse.id, terms.pricing.bookId, ...terms.lines.map(l => l.productId ?? '')]
  const refs = await tx.externalReference.findMany({ where: { connectionId, entityId: { in: identities } } })
  const get = (type: string, entityId: string) => {
    const found = refs.filter(r => r.entityType === type && r.entityId === entityId)
    if (found.length !== 1) throw new ExchangeError('sale_' + type + '_mapping_required')
    return found[0]
  }
  const channel = ChannelMappingSchema.safeParse(get('channel', terms.channel.id).sourceData)
  const warehouse = get('location', terms.warehouse.id), book = get('priceType', terms.pricing.bookId)
  const seller = get('seller', terms.channel.id)
  const legal = SellerRequisitesSchema.safeParse(seller.sourceData)
  if (!channel.success || channel.data.channelId !== terms.channel.id || channel.data.warehouseExternalId !== warehouse.externalId
    || channel.data.priceTypeExternalId !== book.externalId || channel.data.sellerExternalId !== seller.externalId
    || !legal.success || fingerprint(legal.data) !== fingerprint(terms.seller)) throw new ExchangeError('sale_channel_mapping_mismatch')
  const warehouseAddress = WarehouseAddressSchema.safeParse((warehouse.sourceData as { warehouseAddress?: unknown } | null)?.warehouseAddress)
  if (!warehouseAddress.success) throw new ExchangeError('sale_warehouse_address_required')
  const variants = await tx.productVariant.findMany({ where: { storeId, productId: { in: terms.lines.map(l => l.productId ?? '') }, isDefault: true }, select: { id: true, productId: true, unitsPerPack: true } })
  const mapping: SaleReferences = {
    warehouseAddress: warehouseAddress.data,
    customer: await saleCustomerIdentity(tx, terms, connectionId), seller: seller.externalId, warehouse: warehouse.externalId, priceType: book.externalId,
    products: terms.lines.map(line => {
      const matches = variants.filter(v => v.productId === line.productId)
      if (matches.length !== 1 || matches[0].id !== line.variantId || matches[0].unitsPerPack !== 1) throw new ExchangeError('sale_variant_mapping_ambiguous')
      const ref = get('product', line.productId!)
      const unit = SaleUnitSchema.safeParse((ref.sourceData as { baseUnit?: unknown } | null)?.baseUnit)
      if (!unit.success) throw new ExchangeError('sale_product_unit_required')
      return { externalId: ref.externalId, unit: unit.data }
    }),
  }
  return saleDocument(terms, mapping, profile)
}

/** A session has one immutable response: late/repeated success cannot acknowledge a later batch. */
export async function querySales(authority: SessionAuthority, client: PrismaClient = db) {
  assertCapability('commerce-core')

  return client.$transaction(async tx => {
    const { session, profile } = await authorized(tx, authority)
    const previous = await tx.onecSaleBatch.findUnique({ where: { sessionId: session.id } })
    if (previous) {
      const blocked = await tx.onecSaleBatchItem.count({ where: { batchId: previous.id, delivery: { export: { order: { status: { notIn: EXPORTABLE_ORDER_STATUSES } } } } } })
      if (blocked) throw new ExchangeError('sale_batch_order_not_exportable')
      if (previous.sha256 !== sha256(Buffer.from(previous.xml))) throw new ExchangeError('sale_batch_corrupt')
      return previous.xml
    }
    const candidates = await tx.orderExport.findMany({ where: { storeId: authority.storeId, connectionId: session.connectionId,
      status: { in: ['PENDING', 'RETRYING', 'AWAITING_ACK'] }, availableAt: { lte: new Date() }, externalId: null,
      order: { status: { in: EXPORTABLE_ORDER_STATUSES } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20 })
    const documents: string[] = [], deliveryIds: string[] = []
    for (const candidate of candidates) {
      const [order] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Order" WHERE id = ${candidate.orderId} AND "storeId" = ${authority.storeId} FOR UPDATE`
      if (!order || !EXPORTABLE_ORDER_STATUSES.includes(order.status as typeof EXPORTABLE_ORDER_STATUSES[number])) continue
      await tx.$queryRaw`SELECT id FROM "OrderExport" WHERE id = ${candidate.id} FOR UPDATE`
      const record = await tx.orderExport.findUniqueOrThrow({ where: { id: candidate.id } })
      if (!['PENDING', 'RETRYING', 'AWAITING_ACK'].includes(record.status) || record.externalId || record.connectionId !== session.connectionId) continue
      let delivery = await tx.onecSaleDelivery.findUnique({ where: { exportId: record.id } })
      if (!delivery) {
        if (record.attempts >= record.maxAttempts) continue
        const xml = await documentFor(tx, record.orderId, authority.storeId, session.connectionId, profile)
        delivery = await tx.onecSaleDelivery.create({ data: { exportId: record.id, connectionId: session.connectionId, xml, sha256: sha256(Buffer.from(xml)) } })
        await tx.orderExport.update({ where: { id: record.id }, data: { status: 'AWAITING_ACK', attempts: { increment: 1 }, lastError: null, leaseToken: null, leaseExpiresAt: null } })
      }
      if (delivery.connectionId !== session.connectionId || delivery.sha256 !== sha256(Buffer.from(delivery.xml))) throw new ExchangeError('sale_delivery_corrupt')
      documents.push(delivery.xml); deliveryIds.push(delivery.id)
    }
    const xml = saleEnvelope(documents, new Date())
    if (Buffer.byteLength(xml) > 4 * 1024 * 1024) throw new ExchangeError('sale_batch_too_large', 413)
    await tx.onecSaleBatch.create({ data: { sessionId: session.id, xml, sha256: sha256(Buffer.from(xml)),
      items: { create: deliveryIds.map(deliveryId => ({ deliveryId })) } } })
    return xml
  }, { timeout: 30_000 })
}

/** Transport receipt only. Never invent an ERP document ID, business decision or invoice. */
export async function acknowledgeSales(authority: SessionAuthority, client: PrismaClient = db) {
  return client.$transaction(async tx => {
    const { session } = await authorized(tx, authority)
    const batch = await tx.onecSaleBatch.findUnique({ where: { sessionId: session.id }, include: { items: { include: { delivery: { include: { export: true } } } } } })
    if (!batch) throw new ExchangeError('sale_query_required')
    if (batch.receivedAt) return
    const receivedAt = new Date()
    for (const item of [...batch.items].sort((a, b) => a.delivery.export.orderId.localeCompare(b.delivery.export.orderId))) {
      const record = item.delivery.export
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${record.orderId} FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM "OrderExport" WHERE id = ${record.id} FOR UPDATE`
      await tx.onecSaleDelivery.update({ where: { id: item.deliveryId }, data: { receivedAt } })
      await tx.orderExport.updateMany({ where: { id: record.id, connectionId: session.connectionId, status: 'AWAITING_ACK' }, data: { status: 'DELIVERED', submittedAt: receivedAt } })
    }
    await tx.onecSaleBatch.update({ where: { id: batch.id }, data: { receivedAt } })
  })
}
