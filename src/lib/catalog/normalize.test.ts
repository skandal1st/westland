import { describe, expect, it } from 'vitest'
import { NormalizationError, fingerprint, normalizeProductSnapshot } from '@/lib/catalog/normalize'

describe('fingerprint', () => {
  it('is stable regardless of key order', () => {
    expect(fingerprint({ a: 1, b: [2, 3], c: { d: 4 } })).toBe(fingerprint({ c: { d: 4 }, b: [2, 3], a: 1 }))
  })
  it('changes when a value changes', () => {
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }))
  })
})

describe('normalizeProductSnapshot', () => {
  it('maps a raw payload to the canonical form', () => {
    const n = normalizeProductSnapshot({
      externalId: 'EXT-1', sku: 'SKU-1', name: '  Табак 25 ', categoryExternalId: 'C1', brandExternalId: 'B1',
      packaging: '25 г', unitsPerPack: 40, barcode: '460000000001', archived: false, sourceUpdatedAt: '2026-01-01T00:00:00Z',
    })
    expect(n.externalId).toBe('EXT-1')
    expect(n.sku).toBe('SKU-1')
    expect(n.canonicalName).toBe('Табак 25')
    expect(n.packaging).toBe('25 г')
    expect(n.unitsPerPack).toBe(40)
    expect(n.identifiers).toContainEqual({ type: 'BARCODE', value: '460000000001' })
    expect(n.archived).toBe(false)
    expect(n.sourceUpdatedAt).toBeInstanceOf(Date)
  })

  it('throws when required fields are missing', () => {
    expect(() => normalizeProductSnapshot({ sku: 'x', name: 'y' })).toThrow(NormalizationError)
    expect(() => normalizeProductSnapshot({ externalId: 'x', name: 'y' })).toThrow(/sku/)
    expect(() => normalizeProductSnapshot({ externalId: 'x', sku: 'y' })).toThrow(/name/)
  })

  it('marks archived from deleted flag', () => {
    expect(normalizeProductSnapshot({ externalId: 'x', sku: 'y', name: 'z', deleted: true }).archived).toBe(true)
  })
})
