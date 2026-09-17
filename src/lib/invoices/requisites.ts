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
  city: z.string().optional(),
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

/**
 * Backoffice input for store-level seller requisites: every field optional so
 * staff can fill them incrementally. Issuance still validates the strict
 * SellerRequisitesSchema (company + INN required), so a partial save can never
 * emit a legally empty invoice — it just blocks issue with a clear error.
 */
export const StoreRequisitesInputSchema = z.object({
  companyName: z.string().trim().max(200).optional(),
  inn: z.string().trim().max(20).optional(),
  kpp: z.string().trim().max(20).optional(),
  city: z.string().trim().max(100).optional(),
  legalAddress: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(50).optional(),
  email: z.string().trim().max(120).optional(),
  bank: z
    .object({
      name: z.string().trim().max(200).optional(),
      bik: z.string().trim().max(20).optional(),
      account: z.string().trim().max(40).optional(),
      corAccount: z.string().trim().max(40).optional(),
    })
    .partial()
    .optional(),
  directorName: z.string().trim().max(200).optional(),
  accountantName: z.string().trim().max(200).optional(),
  vatEnabled: z.boolean().optional(),
  vatRate: z.number().nonnegative().max(100).optional(),
  paymentPurpose: z.string().trim().max(300).optional(),
})

export type StoreRequisitesInput = z.infer<typeof StoreRequisitesInputSchema>

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
