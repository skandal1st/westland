import { assertCapability } from '@/lib/capabilities'
import { MoneyError } from '@/lib/money'
import { captureCommercialSnapshot } from './commercial-snapshot'
import { submitTransaction } from './transaction'
import { Prisma, type OrderStatus, type PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { AuditAction, recordAudit } from '@/lib/audit'
import { canTransition, mapProviderStatus } from '@/lib/orders/state'
import { enqueueOrderExport } from '@/lib/integrations/order-export'
import type { OperationalProvider } from '@/lib/integrations/provider'
import type { SessionUser } from '@/lib/authz'
import { resolveActiveSource } from '@/lib/integrations/sources'
import { assertDraftFresh, priceDraft, quoteTerms } from './draft'
import { OrderError, type DraftQuote } from './errors'
export { OrderError } from './errors'

async function lockOrder(tx: Prisma.TransactionClient, storeId: string, orderId: string) {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} AND "storeId" = ${storeId} FOR UPDATE`
}

async function auditTransition(tx: Prisma.TransactionClient, order: { id: string; storeId: string; status: OrderStatus }, to: OrderStatus, actor: SessionUser | null) {
  await recordAudit(tx, { storeId: order.storeId, actor, action: AuditAction.OrderStatusChanged, targetType: 'Order', targetId: order.id,
    summary: `${order.status} -> ${to}`, metadata: { from: order.status, to } })
}

/** Persist a fresh quote without sending; only its exact, still-current token authorizes changed prices. */
export async function submitOrder(
  user: SessionUser, orderId: string, client: PrismaClient = defaultPrisma,
  input: { priceConfirmationToken?: string } = {},
) {
  assertCapability('commerce-b2b')

  const result = await submitTransaction(client, async tx => {
    await lockOrder(tx, user.storeId, orderId)
    const order = await tx.order.findFirst({ where: { id: orderId, userId: user.id, storeId: user.storeId, customerId: user.customerId ?? '' }, include: { items: { orderBy: { id: 'asc' } } } })
    if (!order) throw new OrderError('NOT_FOUND')
    if (['SUBMITTED', 'REVIEW_REQUIRED', 'CONFIRMED', 'PROCESSING', 'COMPLETED'].includes(order.status)) return { order }
    if (order.status !== 'DRAFT') throw new OrderError('INVALID_STATE')
    const pricing = await priceDraft(tx, user, order)
    const { quote, changed } = pricing
    const previous = order.draftPriceQuote as DraftQuote | null
    const accepted = !!input.priceConfirmationToken && previous?.token === input.priceConfirmationToken && quoteTerms(previous) === quoteTerms(quote)
    if ((changed || input.priceConfirmationToken) && !accepted) {
      // Preserve the challenge across repeats/tabs while its terms stay identical.
      const offered = previous && quoteTerms(previous) === quoteTerms(quote) ? previous : quote
      await tx.order.update({ where: { id: order.id }, data: { draftPriceQuote: offered as unknown as Prisma.InputJsonValue } })
      return { quote: offered }
    }
    const connectionId = (await resolveActiveSource(user.storeId, undefined, tx))?.id ?? null
    if (changed) {
      for (const line of quote.lines) await tx.orderItem.update({ where: { id: line.id }, data: { unitPrice: line.unitPrice, lineTotal: line.lineTotal } })
      await recordAudit(tx, { storeId: user.storeId, actor: user, action: 'OrderPriceConfirmed', targetType: 'Order', targetId: order.id,
        metadata: { previousTotal: quote.previousTotal, total: quote.total, currency: quote.currency, token: input.priceConfirmationToken! } })
    }
    const commercialSnapshot = await captureCommercialSnapshot(tx, order, pricing, connectionId)
    await assertDraftFresh(tx, order.createdAt)
    const updated = await tx.order.update({ where: { id: order.id }, data: {
      commercialSnapshot: commercialSnapshot as unknown as Prisma.InputJsonValue,
      status: 'SUBMITTED', total: quote.total, currency: quote.currency, draftPriceQuote: Prisma.DbNull,
    } })
    await enqueueOrderExport({ storeId: user.storeId, orderId: order.id, connectionId }, tx)
    await auditTransition(tx, order, 'SUBMITTED', user)
    return { order: updated }
  }).catch(error => {
    if (error instanceof MoneyError) throw new OrderError(error.code)
    throw error
  })
  if (result.quote) throw new OrderError('PRICE_CHANGED', result.quote)
  return result.order!
}

/** Every status writer and export claim locks Order before OrderExport. */
export async function transitionOrder(
  input: { storeId: string; orderId: string; to: OrderStatus; actor: SessionUser | null; expectedStatus?: OrderStatus },
  client: PrismaClient = defaultPrisma,
) {
  if (input.to !== 'CANCELLED') assertCapability('commerce-core')

  // A generic staff transition cannot bypass the buyer's draft validation/consent.
  if (['SUBMITTED', 'REJECTED', 'REVIEW_REQUIRED'].includes(input.to)) throw new OrderError('INVALID_STATE')
  const observed = await client.order.findFirst({ where: { id: input.orderId, storeId: input.storeId }, select: { status: true } })
  if (!observed) throw new OrderError('NOT_FOUND')
  const expected = input.expectedStatus ?? observed.status
  return client.$transaction(async tx => {
    await lockOrder(tx, input.storeId, input.orderId)
    const order = await tx.order.findFirst({ where: { id: input.orderId, storeId: input.storeId } })
    if (!order) throw new OrderError('NOT_FOUND')
    if (order.status === input.to) return order
    if (order.status !== expected) throw new OrderError('STATE_CHANGED')
    if (order.status === 'REVIEW_REQUIRED' && input.to !== 'CANCELLED') throw new OrderError('INVALID_STATE')
    if (!canTransition(order.status, input.to)) throw new OrderError('INVALID_STATE')
    const updated = await tx.order.update({ where: { id: order.id }, data: { status: input.to } })
    if (input.to === 'CANCELLED') {
      await tx.orderManualConfirmation.updateMany({ where: { orderId: order.id, revokedAt: null }, data: { revokedAt: new Date() } })
      await tx.orderExport.updateMany({ where: { orderId: order.id, status: { in: ['PENDING', 'RETRYING'] } }, data: { status: 'FAILED', lastError: 'order_cancelled' } })
    }
    await auditTransition(tx, order, input.to, input.actor)
    return updated
  })
}

/** A buyer may cancel until the first claim. An attempted delivery stays manager-mediated, including after a timeout. */
export async function cancelOrder(user: SessionUser, orderId: string, client: PrismaClient = defaultPrisma) {
  return client.$transaction(async tx => {
    await lockOrder(tx, user.storeId, orderId)
    const order = await tx.order.findFirst({ where: { id: orderId, storeId: user.storeId, userId: user.id, customerId: user.customerId ?? '' }, include: { export: true } })
    if (!order) throw new OrderError('NOT_FOUND')
    if (['CANCELLED', 'REJECTED'].includes(order.status)) return { order, requested: false }
    if (order.status === 'COMPLETED') throw new OrderError('INVALID_STATE')
    const started = order.export && (order.export.attempts > 0 || !!order.export.externalId || !!order.export.submittedAt || ['PROCESSING', 'SUCCESS'].includes(order.export.status))
    if (started || !['DRAFT', 'SUBMITTED'].includes(order.status)) {
      if (order.cancellationRequestedAt) return { order, requested: true }
      const updated = await tx.order.update({ where: { id: order.id }, data: { cancellationRequestedAt: new Date() } })
      await recordAudit(tx, { storeId: user.storeId, actor: user, action: 'OrderCancellationRequested', targetType: 'Order', targetId: order.id, summary: 'Buyer requested cancellation after transmission began' })
      return { order: updated, requested: true }
    }
    const updated = await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED', draftPriceQuote: Prisma.DbNull } })
    await tx.orderExport.updateMany({ where: { orderId: order.id }, data: { status: 'FAILED', lastError: 'order_cancelled' } })
    await auditTransition(tx, order, 'CANCELLED', user)
    return { order: updated, requested: false }
  })
}

/** Remote I/O is outside locks. A delayed reply must still match the captured local state/export. */
export async function reconcileOrder(
  input: { storeId: string; orderId: string; provider: OperationalProvider; actor: SessionUser | null },
  client: PrismaClient = defaultPrisma,
): Promise<{ changed: boolean; status: OrderStatus }> {
  assertCapability('commerce-core')

  const before = await client.order.findFirst({ where: { id: input.orderId, storeId: input.storeId }, include: { export: true } })
  if (!before) throw new OrderError('NOT_FOUND')
  if (!before.export?.externalId || !input.provider.getOrderStatus) return { changed: false, status: before.status }
  const remote = await input.provider.getOrderStatus(before.export.externalId)
  const mapped = mapProviderStatus(remote.status)
  return client.$transaction(async tx => {
    await lockOrder(tx, input.storeId, input.orderId)
    const order = await tx.order.findFirst({ where: { id: input.orderId, storeId: input.storeId }, include: { export: true } })
    if (!order) throw new OrderError('NOT_FOUND')
    if (!mapped || order.status !== before.status || order.export?.externalId !== before.export?.externalId ||
      order.export?.connectionId !== before.export?.connectionId) return { changed: false, status: order.status }
    if ((mapped === 'REJECTED' || mapped === 'REVIEW_REQUIRED') && (order.status === mapped || canTransition(order.status, mapped))) {
      const message = typeof remote.customerMessage === 'string' ? remote.customerMessage.trim().slice(0, 1000) || null : null
      if (order.status === mapped && order.providerDecisionMessage === message) return { changed: false, status: order.status }
      await tx.order.update({ where: { id: order.id }, data: { status: mapped, providerDecisionMessage: message } })
      await tx.orderManualConfirmation.updateMany({ where: { orderId: order.id, revokedAt: null }, data: { revokedAt: new Date() } })
      // A partial approval or refusal cannot authorize a new invoice or export.
      await tx.orderExport.update({ where: { orderId: order.id }, data: { confirmedAt: null } })
      await tx.orderExport.updateMany({ where: { orderId: order.id, status: { in: ['PENDING', 'RETRYING'] } }, data: { status: 'FAILED', lastError: 'order_decision_blocks_export' } })
      if (order.status !== mapped) await auditTransition(tx, order, mapped, input.actor)
      await recordAudit(tx, { storeId: input.storeId, actor: input.actor, action: 'OrderProviderDecision', targetType: 'Order', targetId: order.id,
        metadata: { status: mapped, customerMessage: message } })
      return { changed: true, status: mapped }
    }
    // Staff may have set CONFIRMED earlier; the first actual provider confirmation
    // still needs its own marker, without repeating the business transition.
    if (mapped === 'CONFIRMED' && order.status === 'CONFIRMED' && !order.export?.confirmedAt) {
      await tx.orderExport.update({ where: { orderId: order.id }, data: { confirmedAt: new Date() } })
      await recordAudit(tx, { storeId: input.storeId, actor: input.actor, action: 'OrderProviderConfirmed', targetType: 'Order', targetId: order.id })
      return { changed: true, status: order.status }
    }
    if (!canTransition(order.status, mapped)) return { changed: false, status: order.status }
    await tx.order.update({ where: { id: order.id }, data: { status: mapped, ...(mapped === 'CONFIRMED' ? { providerDecisionMessage: null } : {}) } })
    if (mapped === 'CONFIRMED') await tx.orderExport.update({ where: { orderId: order.id }, data: { confirmedAt: new Date() } })
    if (mapped === 'CANCELLED') await tx.orderManualConfirmation.updateMany({ where: { orderId: order.id, revokedAt: null }, data: { revokedAt: new Date() } })
    if (mapped === 'CANCELLED') await tx.orderExport.updateMany({ where: { orderId: order.id, status: { in: ['PENDING', 'RETRYING'] } }, data: { status: 'FAILED', lastError: 'order_cancelled' } })
    await auditTransition(tx, order, mapped, input.actor)
    return { changed: true, status: mapped }
  })
}
