import { assertCapability } from '@/lib/capabilities'
import { readCommercialSnapshot } from '@/lib/orders/commercial-snapshot'
import { randomUUID } from 'node:crypto'
import type { OrderExport, OrderStatus, Prisma } from '@prisma/client'
import { executionLease, LEASE_MS } from './lease'
import { recoverExpiredWork, retryDelay } from './recovery'
import { IntegrationInputError } from './errors'
import type { IntegrationConnection, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { getProvider, PULL_ORDER_PROVIDERS } from '@/lib/integrations/registry'
import { ProviderNotConfiguredError, type OperationalProvider, type OrderExportPayload } from '@/lib/integrations/provider'
import { requireActiveSource, SourceProfileError } from '@/lib/integrations/sources'

import { EXPORTABLE_ORDER_STATUSES } from '@/lib/orders/state'

const ENTITY = 'order'

export type ExportResult = { orderId: string; status: 'SUCCESS' | 'RETRYING' | 'FAILED' | 'SKIPPED'; externalId?: string; message?: string }

/** Idempotent enqueue — one OrderExport per order. */
export async function enqueueOrderExport(
  input: { storeId: string; orderId: string; connectionId: string | null },
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<OrderExport> {
  assertCapability('commerce-core')

  if ('$transaction' in client) return client.$transaction(tx => enqueueOrderExport(input, tx))
  const [order] = await client.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Order" WHERE id = ${input.orderId} AND "storeId" = ${input.storeId} FOR UPDATE`
  if (!order || !EXPORTABLE_ORDER_STATUSES.includes(order.status as OrderStatus)) throw new IntegrationInputError('order_not_exportable')
  return client.orderExport.upsert({
    where: { orderId: input.orderId },
    update: {},
    create: { storeId: input.storeId, orderId: input.orderId, connectionId: input.connectionId, status: 'PENDING', availableAt: new Date() },
  })
}

/** Reset a FAILED/errored export back to PENDING for another attempt. */
export async function retryOrderExport(orderId: string, client: PrismaClient = defaultPrisma) {
  assertCapability('commerce-core')

  return client.$transaction(async tx => {
    const [order] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Order" WHERE id = ${orderId} FOR UPDATE`
    if (!order || !EXPORTABLE_ORDER_STATUSES.includes(order.status as OrderStatus)) throw new IntegrationInputError('order_not_exportable')
    const [record] = await tx.$queryRaw<OrderExport[]>`SELECT * FROM "OrderExport" WHERE "orderId" = ${orderId} FOR UPDATE`
    if (!record) return null
    if (record.status === 'SUCCESS' || record.status === 'AWAITING_ACK' || record.status === 'DELIVERED' || record.externalId) return record
    if (record.status === 'PROCESSING') throw new IntegrationInputError('export_running')
    return tx.orderExport.update({ where: { id: record.id }, data: { status: 'PENDING', availableAt: new Date(), lastError: null,
      leaseToken: null, leaseExpiresAt: null, maxAttempts: Math.max(record.maxAttempts, record.attempts + 1) } })
  })
}

async function buildPayload(client: PrismaClient, record: Pick<OrderExport, 'orderId' | 'storeId' | 'connectionId'>): Promise<OrderExportPayload> {
  const order = await client.order.findFirstOrThrow({ where: { id: record.orderId, storeId: record.storeId } })
  const terms = readCommercialSnapshot(order.commercialSnapshot, order)
  if (!terms) throw new IntegrationInputError('order_snapshot_required')
  if (terms.connectionId !== record.connectionId) throw new IntegrationInputError('order_snapshot_source_mismatch')
  return {
    id: terms.orderId, number: terms.number,
    customer: { id: terms.buyer.id, inn: terms.buyer.inn, legalName: terms.buyer.legalName },
    delivery: { name: terms.delivery.name, city: terms.delivery.city, address: terms.delivery.address },
    channel: { code: terms.channel.code, paymentMethod: terms.channel.paymentMethod },
    items: terms.lines.map(item => ({ sku: item.sku, quantity: item.quantity, unitPrice: item.unitPrice })),
    total: terms.total, currency: terms.currency, terms,
  }
}

/** Claim before resolving/calling the provider. A stale snapshot cannot submit.
 * Remote idempotency on order.id is still required (acknowledgement contract R23).
 */
export async function runDueOrderExports(
  options: { now?: Date; limit?: number; storeId?: string; recover?: boolean; orderId?: string; resolveProvider?: (connection: IntegrationConnection) => OperationalProvider } = {},
  client: PrismaClient = defaultPrisma,
): Promise<ExportResult[]> {
  assertCapability('commerce-core')

  if (options.recover !== false) await recoverExpiredWork(client, 100, options.storeId)
  const resolve = options.resolveProvider ?? ((connection) => getProvider(connection))
  const pullConnections = await client.integrationConnection.findMany({ where: { provider: { in: [...PULL_ORDER_PROVIDERS] } }, select: { id: true } })
  const exports = await client.orderExport.findMany({
    where: { OR: [{ connectionId: null }, { connectionId: { notIn: pullConnections.map(c => c.id) } }], ...(options.storeId ? { storeId: options.storeId } : {}), ...(options.orderId ? { orderId: options.orderId } : {}), order: { status: { in: EXPORTABLE_ORDER_STATUSES } }, status: { in: ['PENDING', 'RETRYING'] }, availableAt: { lte: options.now ?? new Date() } },
    orderBy: { availableAt: 'asc' }, take: options.limit ?? 20,
  })
  const results: ExportResult[] = []
  for (const snapshot of exports) {
    assertCapability('commerce-core')
    const record = await client.$transaction(async tx => {
      // Shared ordering with cancellation/retry: Order, then OrderExport.
      const [order] = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "Order"
        WHERE id = ${snapshot.orderId} AND "storeId" = ${snapshot.storeId} FOR UPDATE SKIP LOCKED`
      if (!order || !EXPORTABLE_ORDER_STATUSES.includes(order.status as OrderStatus)) return null
      const [row] = await tx.$queryRaw<OrderExport[]>`SELECT * FROM "OrderExport" WHERE id = ${snapshot.id}
        AND status IN ('PENDING', 'RETRYING') AND "availableAt" <= clock_timestamp() AND attempts < "maxAttempts" FOR UPDATE SKIP LOCKED`
      if (!row) return null
      const [claimed] = await tx.$queryRaw<OrderExport[]>`UPDATE "OrderExport" SET status = 'PROCESSING', attempts = attempts + 1,
        "leaseToken" = ${randomUUID()}, "leaseExpiresAt" = clock_timestamp() + ${LEASE_MS} * interval '1 millisecond', "updatedAt" = clock_timestamp()
        WHERE id = ${row.id} RETURNING *`
      return claimed
    })
    if (!record) continue
    const execution = executionLease(client, { table: 'OrderExport', id: record.id, token: record.leaseToken! })
    const owned = execution.client
    const finish = async (status: 'SUCCESS' | 'RETRYING' | 'FAILED', message?: string, externalId?: string) => {
      await owned.$transaction(async tx => {
        if (externalId && record.connectionId) await tx.externalReference.upsert({
          where: { connectionId_entityType_externalId: { connectionId: record.connectionId, entityType: ENTITY, externalId } },
          update: { entityId: record.orderId }, create: { connectionId: record.connectionId, entityType: ENTITY, entityId: record.orderId, externalId },
        })
        await tx.orderExport.update({ where: { id: record.id }, data: { status, lastError: message ?? null, leaseToken: null, leaseExpiresAt: null,
          ...(externalId ? { externalId, submittedAt: record.submittedAt ?? new Date() } : {}),
          ...(status === 'RETRYING' ? { availableAt: new Date(Date.now() + retryDelay(record.attempts)) } : {}),
        } })
      })
      results.push({ orderId: record.orderId, status, ...(externalId ? { externalId } : {}), ...(message ? { message } : {}) })
    }
    try {
      if (record.externalId) { await finish('SUCCESS', undefined, record.externalId); continue }
      if (!record.connectionId) throw new IntegrationInputError('no operational provider connection')
      const connection = await owned.integrationConnection.findUnique({ where: { id: record.connectionId } })
      if (!connection) throw new IntegrationInputError('connection not found')
      await requireActiveSource(connection.id, record.storeId, owned)
      const provider = execution.provider(resolve(connection))
      if (!provider.submitOrder) throw new IntegrationInputError('provider has no submitOrder')
      const payload = await buildPayload(owned, record)
      const submission = await provider.submitOrder(payload)
      await finish('SUCCESS', undefined, submission.externalId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await owned.integrationError.create({ data: { storeId: record.storeId, connectionId: record.connectionId, code: 'ORDER_EXPORT_FAILED', message, context: { orderId: record.orderId } } })
      await finish(error instanceof SourceProfileError || error instanceof ProviderNotConfiguredError || error instanceof IntegrationInputError || record.attempts >= record.maxAttempts ? 'FAILED' : 'RETRYING', message)
    } finally { await execution.stop() }
  }
  return results
}
