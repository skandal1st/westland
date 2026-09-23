import { MONEY_POLICY, money as exactMoney, lineAmount, sumMoney, grossTax } from '@/lib/money'
import { Prisma, type Order, type OrderItem } from '@prisma/client'
import { z } from 'zod'
import { SellerRequisitesSchema, resolveSellerRequisites } from '@/lib/invoices/requisites'
import { extractVatExact } from '@/lib/invoices/snapshot'
import type { ResolvedPrice } from '@/lib/pricing'
import type { DraftQuote } from './errors'

const money = z.string().regex(/^\d+\.\d{2}$/)
const quantity = z.string().regex(/^\d+(\.\d{1,3})?$/)
export const CommercialSnapshotSchema = z.object({
  version: z.literal(1),
  calculationPolicy: z.literal(MONEY_POLICY).optional(),
  orderId: z.string().min(1), storeId: z.string().min(1), number: z.string().min(1),
  acceptedAt: z.string().datetime(), connectionId: z.string().nullable(),
  seller: SellerRequisitesSchema.nullable(),
  buyer: z.object({ id: z.string(), legalName: z.string(), inn: z.string(), kpp: z.string().nullable() }),
  delivery: z.object({ id: z.string(), name: z.string(), city: z.string(), address: z.string() }),
  warehouse: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  channel: z.object({ id: z.string(), code: z.string(), name: z.string(), paymentMethod: z.enum(['BANK_TRANSFER', 'CASH']) }),
  pricing: z.object({ groupId: z.string().nullable(), bookId: z.string(), bookCode: z.string(), bookName: z.string() }),
  tax: z.object({ mode: z.enum(['GROSS_INCLUDED', 'NO_VAT', 'UNCONFIGURED']), rate: z.number().nullable(), subtotal: money.nullable(), amount: money.nullable() }),
  currency: z.string().min(1), total: money, comment: z.string(),
  lines: z.array(z.object({
    id: z.string(), productId: z.string().nullable(), variantId: z.string().nullable(),
    sku: z.string(), sourceSku: z.string().nullable(), name: z.string(), packaging: z.string(),
    quantity, unitPrice: money, lineTotal: money, listUnitPrice: money, promotionIds: z.array(z.string()),
  })).min(1),
})
export type CommercialSnapshot = z.infer<typeof CommercialSnapshotSchema>

/** Fail closed for legacy/unknown schemas; never reconstruct historical terms from today's directories. */
export function readCommercialSnapshot(value: unknown, identity: { id: string; storeId: string }): CommercialSnapshot | null {
  const parsed = CommercialSnapshotSchema.safeParse(value)
  if (!parsed.success || parsed.data.orderId !== identity.id || parsed.data.storeId !== identity.storeId) return null
  if (parsed.data.calculationPolicy) {
    try {
      const terms = parsed.data
      if (terms.lines.some(line => lineAmount(line.unitPrice, line.quantity) !== line.lineTotal) || sumMoney(terms.lines.map(line => line.lineTotal)) !== terms.total) return null
      if (terms.seller) {
        const vat = grossTax(terms.total, terms.seller)
        if (terms.tax.subtotal !== vat.subtotal || terms.tax.amount !== vat.vatAmount || terms.tax.rate !== vat.vatRate || terms.tax.mode !== (vat.vatRate === null ? 'NO_VAT' : 'GROSS_INCLUDED')) return null
      } else if (terms.tax.mode !== 'UNCONFIGURED' || terms.tax.amount !== null || terms.tax.subtotal !== null || terms.tax.rate !== null) return null
    } catch { return null }
  }
  return parsed.data
}

/** Called only inside the submit transaction's repeatable read view, after price consent. */
export async function captureCommercialSnapshot(
  tx: Prisma.TransactionClient,
  order: Order & { items: OrderItem[] },
  pricing: { quote: DraftQuote; prices: Map<string, ResolvedPrice>; groupId: string | null; bookId: string | null },
  connectionId: string | null,
): Promise<CommercialSnapshot> {
  const [customer, delivery, channel, warehouse, settings, book] = await Promise.all([
    tx.customer.findUniqueOrThrow({ where: { id: order.customerId } }),
    tx.customerLocation.findUniqueOrThrow({ where: { id: order.deliveryLocationId } }),
    tx.fulfillmentChannel.findUniqueOrThrow({ where: { id: order.fulfillmentChannelId } }),
    tx.inventoryLocation.findUniqueOrThrow({ where: { id: order.inventoryLocationId } }),
    tx.appSettings.findUnique({ where: { storeId: order.storeId }, select: { sellerRequisites: true } }),
    tx.priceBook.findUniqueOrThrow({ where: { id: pricing.bookId ?? '' } }),
  ])
  const seller = resolveSellerRequisites({ channelSellerLegalEntity: channel.sellerLegalEntity,
    channelInvoiceProfile: channel.invoiceProfile, storeSellerRequisites: settings?.sellerRequisites })
  const vat = seller ? extractVatExact(pricing.quote.total, seller) : null
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
  return CommercialSnapshotSchema.parse({
    version: 1, calculationPolicy: MONEY_POLICY, orderId: order.id, storeId: order.storeId, number: order.number,
    acceptedAt: clock.now.toISOString(), connectionId, seller,
    buyer: { id: customer.id, legalName: customer.legalName, inn: customer.inn, kpp: customer.kpp },
    delivery: { id: delivery.id, name: delivery.name, city: delivery.city, address: delivery.address },
    warehouse: { id: warehouse.id, code: warehouse.code, name: warehouse.name },
    channel: { id: channel.id, code: channel.code, name: channel.name, paymentMethod: order.paymentMethod },
    pricing: { groupId: pricing.groupId, bookId: book.id, bookCode: book.code, bookName: book.name },
    tax: { mode: !vat ? 'UNCONFIGURED' : vat.vatRate === null ? 'NO_VAT' : 'GROSS_INCLUDED',
      rate: vat?.vatRate ?? null, subtotal: vat ? vat.subtotal : null,
      amount: vat ? vat.vatAmount : null },
    total: pricing.quote.total, currency: pricing.quote.currency, comment: order.comment,
    lines: order.items.map(item => {
      const line = pricing.quote.lines.find(candidate => candidate.id === item.id)!
      const price = pricing.prices.get(item.variantId!)!
      return { id: item.id, productId: item.productId, variantId: item.variantId,
        sku: item.sku, sourceSku: item.sourceSku, name: item.productName, packaging: item.packaging,
        quantity: line.quantity, unitPrice: line.unitPrice, lineTotal: line.lineTotal,
        listUnitPrice: item.giftPromotionId ? '0.00' : exactMoney(price.listAmountExact ?? price.amountExact), promotionIds: item.giftPromotionId ? [item.giftPromotionId] : price.promotionIds ?? [] }
    }),
  })
}
