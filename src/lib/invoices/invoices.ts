import { assertCapability } from '@/lib/capabilities'
import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { AuditAction, recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/authz'
import { InvoiceBankSchema, type BuyerSnapshot, type SellerRequisites } from '@/lib/invoices/requisites'
import { hasInvoiceConfirmation } from '@/lib/orders/confirmation'
import { readCommercialSnapshot } from '@/lib/orders/commercial-snapshot'

export class InvoiceError extends Error {
  constructor(public code: 'ORDER_NOT_FOUND' | 'INVALID_STATE' | 'NO_SELLER_REQUISITES' | 'NOT_FOUND' | 'SNAPSHOT_REQUIRED' | 'NO_BANK_REQUISITES' | 'INVALID_INPUT' | 'VERSION_CONFLICT' | 'REQUEST_CONFLICT' | 'NUMBER_CONFLICT') {
    super(code)
    this.name = 'InvoiceError'
  }
}

const invoiceWithLines = { lines: { orderBy: { position: 'asc' } } } satisfies Prisma.InvoiceInclude
export type InvoiceWithLines = Prisma.InvoiceGetPayload<{ include: typeof invoiceWithLines }>

/**
 * Issue/reissue from the terms accepted at submit. Directory changes never
 * replace historical terms. Legacy orders require explicit recovery, not a live fallback.
 */
export async function issueInvoice(
  input: { storeId: string; orderId: string; actor: SessionUser | null; expectedVersion?: number; requestKey?: string },
  client: PrismaClient = defaultPrisma,
): Promise<InvoiceWithLines & { repeated: boolean }> {
  assertCapability('invoices')

  const expectedVersion = input.expectedVersion ?? 0
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 2147483646 || (input.requestKey !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestKey))) throw new InvoiceError('INVALID_INPUT')
  const requestKey = input.requestKey?.toLowerCase()
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${input.orderId} AND "storeId" = ${input.storeId} FOR UPDATE`
    const order = await tx.order.findFirst({ where: { id: input.orderId, storeId: input.storeId }, include: { export: true, manualConfirmation: true } })
    if (!order) throw new InvoiceError('ORDER_NOT_FOUND')
    if (!['CONFIRMED', 'PROCESSING', 'COMPLETED'].includes(order.status)) throw new InvoiceError('INVALID_STATE')
    const terms = readCommercialSnapshot(order.commercialSnapshot, order)
    if (!terms) throw new InvoiceError('SNAPSHOT_REQUIRED')
    if (!hasInvoiceConfirmation(order, terms)) throw new InvoiceError('INVALID_STATE')
    if (requestKey) {
      const previous = await tx.invoice.findUnique({ where: { orderId_issueRequestKey: { orderId: order.id, issueRequestKey: requestKey } }, include: invoiceWithLines })
      if (previous) {
        if (previous.version !== expectedVersion + 1) throw new InvoiceError('REQUEST_CONFLICT')
        return { ...previous, repeated: true } // A late replay may be VOID; never reactivate or reissue it.
      }
    }
    const latest = await tx.invoice.findFirst({ where: { orderId: order.id }, orderBy: { version: 'desc' }, select: { version: true } })
    if ((latest?.version ?? 0) !== expectedVersion) throw new InvoiceError('VERSION_CONFLICT')
    const seller = terms.seller
    if (!seller || !seller.companyName.trim() || !seller.inn.trim() || terms.tax.subtotal === null || terms.tax.amount === null) throw new InvoiceError('NO_SELLER_REQUISITES')
    const paymentMethod = terms.channel.paymentMethod
    if (paymentMethod === 'BANK_TRANSFER' && !InvoiceBankSchema.safeParse(seller.bank).success) throw new InvoiceError('NO_BANK_REQUISITES')
    // Cash documents do not carry bank-transfer instructions, even if the seller has them.
    const invoiceSeller = { ...seller }
    if (paymentMethod === 'CASH') { delete invoiceSeller.bank; delete invoiceSeller.paymentPurpose }
    const buyer: BuyerSnapshot = {
      legalName: terms.buyer.legalName, inn: terms.buyer.inn, kpp: terms.buyer.kpp,
      deliveryName: terms.delivery.name, deliveryAddress: terms.delivery.address, deliveryCity: terms.delivery.city,
    }

    const version = (latest?.version ?? 0) + 1
    const number = version === 1 ? terms.number : `${terms.number}-R${version}`
    if (version > 1) await tx.invoice.updateMany({ where: { orderId: order.id, status: 'ISSUED' }, data: { status: 'VOID' } })
    const invoice = await tx.invoice.create({
      data: {
        storeId: input.storeId, orderId: order.id, number, version, status: 'ISSUED', issueRequestKey: requestKey,
        paymentMethod,
        sellerSnapshot: invoiceSeller as unknown as Prisma.InputJsonValue,
        buyerSnapshot: buyer as unknown as Prisma.InputJsonValue,
        subtotal: terms.tax.subtotal, vatRate: terms.tax.rate, vatAmount: terms.tax.amount,
        total: terms.total, currency: terms.currency,
        lines: { create: terms.lines.map((item, index) => ({
          position: index + 1, sku: item.sourceSku ?? item.sku, name: item.name, packaging: item.packaging,
          quantity: item.quantity, unitPrice: item.unitPrice, lineTotal: item.lineTotal,
        })) },
      }, include: invoiceWithLines,
    })
    await recordAudit(tx, {
      storeId: input.storeId, actor: input.actor,
      action: version === 1 ? AuditAction.InvoiceIssued : AuditAction.InvoiceReissued,
      targetType: 'Invoice', targetId: invoice.id,
      summary: `Invoice ${number} v${version} for order ${terms.number}`,
      metadata: { orderId: order.id, version, expectedVersion, requestKey: requestKey ?? null, total: terms.total, snapshotVersion: terms.version, acceptedAt: terms.acceptedAt },
    })
    return { ...invoice, repeated: false }
  }).catch(error => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new InvoiceError('NUMBER_CONFLICT')
    throw error
  })
}

/** The current (latest ISSUED) invoice for an order, with lines — or null. */
export async function getCurrentInvoice(
  input: { storeId: string; orderId: string },
  client: PrismaClient = defaultPrisma,
): Promise<InvoiceWithLines | null> {
  return client.invoice.findFirst({
    where: { storeId: input.storeId, orderId: input.orderId, status: 'ISSUED' },
    orderBy: { version: 'desc' },
    include: invoiceWithLines,
  })
}

/** Typed accessors for the snapshot JSON (stored as immutable at issue time). */
export function sellerOf(invoice: { sellerSnapshot: unknown }): SellerRequisites | null {
  return (invoice.sellerSnapshot as SellerRequisites | null) ?? null
}
export function buyerOf(invoice: { buyerSnapshot: unknown }): BuyerSnapshot | null {
  return (invoice.buyerSnapshot as BuyerSnapshot | null) ?? null
}
