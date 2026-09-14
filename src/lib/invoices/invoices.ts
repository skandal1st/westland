import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { AuditAction, recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/authz'
import { resolveSellerRequisites, type BuyerSnapshot, type SellerRequisites } from '@/lib/invoices/requisites'
import { extractVat } from '@/lib/invoices/snapshot'

export class InvoiceError extends Error {
  constructor(public code: 'ORDER_NOT_FOUND' | 'INVALID_STATE' | 'NO_SELLER_REQUISITES' | 'NOT_FOUND') {
    super(code)
    this.name = 'InvoiceError'
  }
}

const invoiceWithLines = { lines: { orderBy: { position: 'asc' } } } satisfies Prisma.InvoiceInclude
export type InvoiceWithLines = Prisma.InvoiceGetPayload<{ include: typeof invoiceWithLines }>

/**
 * Issue an invoice for an order: snapshot seller requisites, buyer identity, VAT
 * and every line AT THIS MOMENT. The snapshot is immutable — later changes to
 * the store's seller requisites or the order never touch an issued invoice. A
 * reissue creates a new version and VOIDs the previous ISSUED invoice(s); the
 * old rows are left untouched. Requires configured seller requisites (company +
 * INN) or it blocks with NO_SELLER_REQUISITES.
 */
export async function issueInvoice(
  input: { storeId: string; orderId: string; actor: SessionUser | null },
  client: PrismaClient = defaultPrisma,
): Promise<InvoiceWithLines> {
  const order = await client.order.findFirst({
    where: { id: input.orderId, storeId: input.storeId },
    include: {
      items: true,
      customer: { select: { legalName: true, inn: true, kpp: true } },
      deliveryLocation: { select: { name: true, address: true, city: true } },
      fulfillmentChannel: { select: { sellerLegalEntity: true, invoiceProfile: true } },
    },
  })
  if (!order) throw new InvoiceError('ORDER_NOT_FOUND')
  if (order.status === 'DRAFT' || order.status === 'CANCELLED') throw new InvoiceError('INVALID_STATE')

  const settings = await client.appSettings.findUnique({ where: { storeId: input.storeId }, select: { sellerRequisites: true } })
  const seller = resolveSellerRequisites({
    channelSellerLegalEntity: order.fulfillmentChannel.sellerLegalEntity,
    channelInvoiceProfile: order.fulfillmentChannel.invoiceProfile,
    storeSellerRequisites: settings?.sellerRequisites,
  })
  if (!seller) throw new InvoiceError('NO_SELLER_REQUISITES')

  const buyer: BuyerSnapshot = {
    legalName: order.customer.legalName,
    inn: order.customer.inn,
    kpp: order.customer.kpp,
    deliveryName: order.deliveryLocation.name,
    deliveryAddress: order.deliveryLocation.address,
    deliveryCity: order.deliveryLocation.city,
  }

  const vat = extractVat(Number(order.total), seller)

  const existing = await client.invoice.findMany({ where: { orderId: order.id }, select: { version: true } })
  const version = existing.reduce((max, i) => Math.max(max, i.version), 0) + 1
  const number = version === 1 ? order.number : `${order.number}-R${version}`

  return client.$transaction(async (tx) => {
    if (version > 1) {
      await tx.invoice.updateMany({ where: { orderId: order.id, status: 'ISSUED' }, data: { status: 'VOID' } })
    }
    const invoice = await tx.invoice.create({
      data: {
        storeId: input.storeId,
        orderId: order.id,
        number,
        version,
        status: 'ISSUED',
        sellerSnapshot: seller as unknown as Prisma.InputJsonValue,
        buyerSnapshot: buyer as unknown as Prisma.InputJsonValue,
        subtotal: vat.subtotal,
        vatRate: vat.vatRate,
        vatAmount: vat.vatAmount,
        total: vat.total,
        currency: order.currency,
        lines: {
          create: order.items.map((item, index) => ({
            position: index + 1,
            sku: item.sku,
            name: item.productName,
            packaging: item.packaging,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineTotal: item.lineTotal,
          })),
        },
      },
      include: invoiceWithLines,
    })
    await recordAudit(tx, {
      storeId: input.storeId,
      actor: input.actor,
      action: version === 1 ? AuditAction.InvoiceIssued : AuditAction.InvoiceReissued,
      targetType: 'Invoice',
      targetId: invoice.id,
      summary: `Invoice ${number} v${version} for order ${order.number}`,
      metadata: { orderId: order.id, version, total: vat.total },
    })
    return invoice
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
