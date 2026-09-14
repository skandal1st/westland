import { describe, expect, it } from 'vitest'
import { extractVat } from '@/lib/invoices/snapshot'

describe('extractVat', () => {
  it('extracts VAT from a gross total when enabled', () => {
    expect(extractVat(120, { vatEnabled: true, vatRate: 20 })).toEqual({ subtotal: 100, vatRate: 20, vatAmount: 20, total: 120 })
  })

  it('rounds the extracted tax to kopecks', () => {
    const r = extractVat(200, { vatEnabled: true, vatRate: 20 })
    expect(r.vatAmount).toBe(33.33)
    expect(r.subtotal).toBe(166.67)
    expect(r.total).toBe(200)
  })

  it('is "Без НДС" when disabled — no tax, subtotal equals total', () => {
    expect(extractVat(120, { vatEnabled: false })).toEqual({ subtotal: 120, vatRate: null, vatAmount: 0, total: 120 })
  })

  it('treats a zero/absent rate as no VAT', () => {
    expect(extractVat(120, { vatEnabled: true, vatRate: 0 }).vatRate).toBeNull()
    expect(extractVat(120, { vatEnabled: true }).vatRate).toBeNull()
  })
})
