import type { SellerRequisites } from '@/lib/invoices/requisites'

export type VatBreakdown = { subtotal: number; vatRate: number | null; vatAmount: number; total: number }

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * VAT is extracted from the gross total — invoice prices already include tax
 * (Russian УПД convention). When VAT is disabled or has no positive rate the
 * document is "Без НДС": vatAmount is 0 and the whole total is the subtotal.
 * Pure and deterministic so an invoice's numbers depend only on its snapshot.
 */
export function extractVat(total: number, requisites: Pick<SellerRequisites, 'vatEnabled' | 'vatRate'>): VatBreakdown {
  const rate = requisites.vatEnabled && requisites.vatRate && requisites.vatRate > 0 ? requisites.vatRate : null
  if (rate === null) return { subtotal: round2(total), vatRate: null, vatAmount: 0, total: round2(total) }
  const vatAmount = round2((total * rate) / (100 + rate))
  return { subtotal: round2(total - vatAmount), vatRate: rate, vatAmount, total: round2(total) }
}
