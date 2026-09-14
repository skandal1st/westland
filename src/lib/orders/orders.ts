import type { OrderStatus, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { AuditAction, recordAudit } from '@/lib/audit'
import { canTransition, mapProviderStatus } from '@/lib/orders/state'
import { enqueueOrderExport } from '@/lib/integrations/order-export'
import type { OperationalProvider } from '@/lib/integrations/provider'
import type { SessionUser } from '@/lib/authz'
import { issueInvoice, InvoiceError } from '@/lib/invoices/invoices'
import { logger } from '@/lib/logger'

export class OrderError extends Error {
  constructor(public code: 'NOT_FOUND' | 'INVALID_STATE') {
    super(code)
    this.name = 'OrderError'
  }
}

async function resolvePrimaryConnectionId(storeId: string, client: PrismaClient): Promise<string | null> {
  const enabled = await client.integrationConnection.findFirst({ where: { storeId, enabled: true }, select: { id: true } })
  if (enabled) return enabled.id
  const any = await client.integrationConnection.findFirst({ where: { storeId }, select: { id: true } })
  return any?.id ?? null
}

/**
 * Submit a DRAFT order: business transition DRAFT -> SUBMITTED and enqueue a
 * durable export. The response is not blocked by the export; a provider outage
 * leaves the order SUBMITTED with the export PENDING/RETRYING. Idempotent — an
 * already-SUBMITTED order is returned unchanged.
 */
export async function submitOrder(user: SessionUser, orderId: string, client: PrismaClient = defaultPrisma) {
  const order = await client.order.findFirst({ where: { id: orderId, userId: user.id, storeId: user.storeId } })
  if (!order) throw new OrderError('NOT_FOUND')
  if (order.status === 'SUBMITTED') return order // idempotent
  if (order.status !== 'DRAFT') throw new OrderError('INVALID_STATE')

  const connectionId = await resolvePrimaryConnectionId(user.storeId, client)

  const updated = await client.$transaction(async (tx) => {
    const result = await tx.order.update({ where: { id: order.id }, data: { status: 'SUBMITTED' } })
    await enqueueOrderExport({ storeId: user.storeId, orderId: order.id, connectionId }, tx as unknown as PrismaClient)
    await recordAudit(tx, { storeId: user.storeId, actor: user, action: AuditAction.OrderStatusChanged, targetType: 'Order', targetId: order.id, summary: `DRAFT -> SUBMITTED`, metadata: { from: 'DRAFT', to: 'SUBMITTED' } })
    return result
  })

  // Best-effort invoice issue so the buyer's success path (order + PDF) works
  // when seller requisites are configured. Missing requisites never block the
  // submit — staff can issue later from the backoffice.
  try {
    await issueInvoice({ storeId: user.storeId, orderId: order.id, actor: user }, client)
  } catch (error) {
    if (error instanceof InvoiceError && error.code === 'NO_SELLER_REQUISITES') {
      logger.info('invoice deferred: seller requisites not configured', { orderId: order.id })
    } else {
      logger.error('auto-issue invoice failed', { orderId: order.id, error: (error as Error).message })
    }
  }

  return updated
}

/** Advance the business status (staff / reconciliation). Invalid transitions are rejected. */
export async function transitionOrder(
  input: { storeId: string; orderId: string; to: OrderStatus; actor: SessionUser | null },
  client: PrismaClient = defaultPrisma,
) {
  const order = await client.order.findFirst({ where: { id: input.orderId, storeId: input.storeId } })
  if (!order) throw new OrderError('NOT_FOUND')
  if (order.status === input.to) return order
  if (!canTransition(order.status, input.to)) throw new OrderError('INVALID_STATE')

  return client.$transaction(async (tx) => {
    const updated = await tx.order.update({ where: { id: order.id }, data: { status: input.to } })
    await recordAudit(tx, { storeId: input.storeId, actor: input.actor, action: AuditAction.OrderStatusChanged, targetType: 'Order', targetId: order.id, summary: `${order.status} -> ${input.to}`, metadata: { from: order.status, to: input.to } })
    return updated
  })
}

/**
 * Reconcile business status from the provider. Maps the opaque provider status
 * onto the business lifecycle and advances only on a valid forward transition —
 * provider-specific statuses never enter Order.status.
 */
export async function reconcileOrder(
  input: { storeId: string; orderId: string; provider: OperationalProvider; actor: SessionUser | null },
  client: PrismaClient = defaultPrisma,
): Promise<{ changed: boolean; status: OrderStatus }> {
  const order = await client.order.findFirst({ where: { id: input.orderId, storeId: input.storeId }, include: { export: true } })
  if (!order) throw new OrderError('NOT_FOUND')
  if (!order.export?.externalId || !input.provider.getOrderStatus) return { changed: false, status: order.status }

  const remote = await input.provider.getOrderStatus(order.export.externalId)
  const mapped = mapProviderStatus(remote.status)
  if (!mapped || !canTransition(order.status, mapped)) return { changed: false, status: order.status }

  const updated = await transitionOrder({ storeId: input.storeId, orderId: order.id, to: mapped, actor: input.actor }, client)
  if (mapped === 'CONFIRMED') await client.orderExport.update({ where: { orderId: order.id }, data: { confirmedAt: new Date() } })
  return { changed: true, status: updated.status }
}
