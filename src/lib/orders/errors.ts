export type DraftQuote = {
  token: string
  currency: string
  previousCurrency: string
  total: string
  previousTotal: string
  lines: Array<{ id: string; name: string; quantity: string; previousUnitPrice: string; unitPrice: string; lineTotal: string }>
}

export class OrderError extends Error {
  constructor(public code: 'NOT_FOUND' | 'INVALID_STATE' | 'STATE_CHANGED' | 'DRAFT_EXPIRED' | 'CHANNEL_UNAVAILABLE' | 'CHANNEL_CHANGED' | 'ITEM_UNAVAILABLE' | 'NO_PRICE' | 'MIXED_CURRENCY' | 'PRICE_CHANGED' | 'INVALID_DELIVERY' | 'INVALID_AMOUNT', public quote?: DraftQuote) {
    super(code)
    this.name = 'OrderError'
  }
}
