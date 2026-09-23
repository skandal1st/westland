import type { SellerRequisites } from '@/lib/invoices/requisites'
import { grossTax, type DecimalInput } from '@/lib/money'

/** Exact document-level VAT extracted from gross; subtotal + VAT always equals gross. */
export const extractVatExact = (total: DecimalInput, requisites: Pick<SellerRequisites, 'vatEnabled' | 'vatRate'>) => grossTax(total, requisites)

/** Numeric compatibility view for existing callers; authoritative persistence uses extractVatExact. */
export function extractVat(total: DecimalInput, requisites: Pick<SellerRequisites, 'vatEnabled' | 'vatRate'>) {
  const value = extractVatExact(total, requisites)
  return { subtotal: Number(value.subtotal), vatRate: value.vatRate, vatAmount: Number(value.vatAmount), total: Number(value.total) }
}
