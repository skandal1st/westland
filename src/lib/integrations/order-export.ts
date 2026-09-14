import type { IntegrationConnection, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { getProvider } from '@/lib/integrations/registry'
import type { OperationalProvider, OrderExportPayload } from '@/lib/integrations/provider'

const ENTITY = 'order'
const BASE_BACKOFF_MS = 1_000

export type ExportResult = { orderId: string; status: 'SUCCESS' | 'RETRYING' | 'FAILED' | 'SKIPPED'; externalId?: string; message?: string }

/** Idempotent enqueue — one OrderExport per order. */
export async function enqueueOrderExport(
  input: { storeId: string; orderId: string; connectionId: string | null },
  client: PrismaClient = defaultPrisma,
) {
  return client.orderExport.upsert({
    where: { orderId: input.orderId },
    update: {},
    create: { storeId: input.storeId, orderId: input.orderId, connectionId: input.connectionId, status: 'PENDING', availableAt: new Date() },
  })
}

/** Reset a FAILED/errored export back to PENDING for another attempt. */
export async function retryOrderExport(orderId: string, client: PrismaClient = defaultPrisma) {
  return client.orderExport.update({ where: { orderId }, data: { status: 'PENDING', availableAt: new Date(), lastError: null } })
}

async function buildPayload(client: PrismaClient, orderId: string): Promise<OrderExportPayload> {
  const order = await client.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      items: true,
      customer: { select: { inn: true, legalName: true } },
      deliveryLocation: { select: { name: true, city: true, address: true } },
      fulfillmentChannel: { select: { code: true, paymentMethod: true } },
    },
  })
  return {
    id: order.id,
    number: order.number,
    customer: { id: order.customerId, inn: order.customer.inn, legalName: order.customer.legalName },
    delivery: { name: order.deliveryLocation.name, city: order.deliveryLocation.city, address: order.deliveryLocation.address },
    channel: { code: order.fulfillmentChannel.code, paymentMethod: order.fulfillmentChannel.paymentMethod },
    items: order.items.map((i) => ({ sku: i.sku, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice) })),
    total: Number(order.total),
    currency: order.currency,
  }
}

/**
 * Process due order exports. Idempotent: an order already exported (externalId
 * present) is never re-submitted, and the mock/real provider also dedupes on the
 * Commerce Order ID — so a double submit yields exactly one order at the
 * provider. Retries are bounded; errors persist. A provider outage never
 * touches the business Order.status.
 */
export async function runDueOrderExports(
  options: { now?: Date; limit?: number; resolveProvider?: (connection: IntegrationConnection) => OperationalProvider } = {},
  client: PrismaClient = defaultPrisma,
): Promise<ExportResult[]> {
  const now = options.now ?? new Date()
  const resolve = options.resolveProvider ?? ((connection) => getProvider(connection))
  const exports = await client.orderExport.findMany({
    where: { status: { in: ['PENDING', 'RETRYING'] }, availableAt: { lte: now } },
    orderBy: { availableAt: 'asc' },
    take: options.limit ?? 20,
  })

  const results: ExportResult[] = []
  for (const record of exports) {
    // Already exported -> idempotent success, no second submit.
    if (record.externalId) {
      await client.orderExport.update({ where: { id: record.id }, data: { status: 'SUCCESS' } })
      results.push({ orderId: record.orderId, status: 'SUCCESS', externalId: record.externalId })
      continue
    }
    if (!record.connectionId) {
      await client.orderExport.update({ where: { id: record.id }, data: { status: 'FAILED', lastError: 'no operational provider connection' } })
      results.push({ orderId: record.orderId, status: 'FAILED', message: 'no connection' })
      continue
    }
    const connection = await client.integrationConnection.findUnique({ where: { id: record.connectionId } })
    if (!connection) {
      await client.orderExport.update({ where: { id: record.id }, data: { status: 'FAILED', lastError: 'connection not found' } })
      results.push({ orderId: record.orderId, status: 'FAILED', message: 'connection missing' })
      continue
    }
    const provider = resolve(connection)
    if (!provider.submitOrder) {
      results.push({ orderId: record.orderId, status: 'SKIPPED', message: 'provider has no submitOrder' })
      continue
    }

    await client.orderExport.update({ where: { id: record.id }, data: { status: 'PROCESSING' } })
    const attempt = record.attempts + 1
    try {
      const payload = await buildPayload(client, record.orderId)
      const submission = await provider.submitOrder(payload) // idempotent on order id
      await client.orderExport.update({
        where: { id: record.id },
        data: { status: 'SUCCESS', externalId: submission.externalId, submittedAt: new Date(), attempts: attempt, lastError: null },
      })
      await client.externalReference.upsert({
        where: { connectionId_entityType_externalId: { connectionId: connection.id, entityType: ENTITY, externalId: submission.externalId } },
        update: { entityId: record.orderId },
        create: { connectionId: connection.id, entityType: ENTITY, entityId: record.orderId, externalId: submission.externalId },
      })
      results.push({ orderId: record.orderId, status: 'SUCCESS', externalId: submission.externalId })
    } catch (error) {
      const message = (error as Error).message
      await client.integrationError.create({ data: { storeId: record.storeId, connectionId: record.connectionId, code: 'ORDER_EXPORT_FAILED', message, context: { orderId: record.orderId } } })
      if (attempt >= record.maxAttempts) {
        await client.orderExport.update({ where: { id: record.id }, data: { status: 'FAILED', attempts: attempt, lastError: message } })
        results.push({ orderId: record.orderId, status: 'FAILED', message })
      } else {
        await client.orderExport.update({ where: { id: record.id }, data: { status: 'RETRYING', attempts: attempt, availableAt: new Date(now.getTime() + BASE_BACKOFF_MS * 2 ** (attempt - 1)), lastError: message } })
        results.push({ orderId: record.orderId, status: 'RETRYING', message })
      }
    }
  }
  return results
}
