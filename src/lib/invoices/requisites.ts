import { z } from 'zod'

/**
 * Seller (issuer) requisites captured onto an invoice at issue time. Values are
 * NEVER hardcoded — they are configured per fulfillment channel
 * (`FulfillmentChannel.sellerLegalEntity` + `invoiceProfile`, M5) with a
 * store-level fallback (`AppSettings.sellerRequisites`). The concrete legal
 * texts / bank details are filled by staff via backoffice (brief: TBD).
 *
 * The minimum for a legally meaningful invoice is a company name + INN; without
 * them the issue is blocked with a clear error rather than emitting a document
 * with empty requisites.
 */
export const SellerRequisitesSchema = z.object({
  companyName: z.string().min(1),
  inn: z.string().min(1),
  kpp: z.string().optional(),
  legalAddress: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  bank: z
    .object({
      name: z.string().optional(),
      bik: z.string().optional(),
      account: z.string().optional(),
      corAccount: z.string().optional(),
    })
    .optional(),
  directorName: z.string().optional(),
  accountantName: z.string().optional(),
  // VAT scheme. When enabled with a rate, tax is EXTRACTED from the total
  // (prices already include VAT, as with a Russian УПД). Otherwise "Без НДС".
  vatEnabled: z.boolean().default(false),
  vatRate: z.number().nonnegative().optional(),
  paymentPurpose: z.string().optional(),
})

export type SellerRequisites = z.infer<typeof SellerRequisitesSchema>

/** Buyer identity snapshot (from the order's customer + delivery point). */
export type BuyerSnapshot = {
  legalName: string
  inn: string
  kpp: string | null
  deliveryName: string
  deliveryAddress: string
  deliveryCity: string
}

/**
 * Merge the channel's seller legal entity (base identity + bank) with its
 * invoice profile (VAT / signatories / payment purpose overlay), falling back
 * to the store-level requisites when the channel has none. Returns a validated
 * `SellerRequisites` or `null` when the minimum (company + INN) is absent.
 */
export function resolveSellerRequisites(input: {
  channelSellerLegalEntity: unknown
  channelInvoiceProfile: unknown
  storeSellerRequisites: unknown
}): SellerRequisites | null {
  const base = asRecord(input.channelSellerLegalEntity) ?? asRecord(input.storeSellerRequisites) ?? {}
  const overlay = asRecord(input.channelInvoiceProfile) ?? {}
  const parsed = SellerRequisitesSchema.safeParse({ ...base, ...overlay })
  return parsed.success ? parsed.data : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
