import { describe, expect, it } from 'vitest'
import { resolveSellerRequisites } from '@/lib/invoices/requisites'

const company = { companyName: 'ООО Продавец', inn: '7712345678' }

describe('resolveSellerRequisites', () => {
  it('uses the channel seller legal entity when present', () => {
    const r = resolveSellerRequisites({ channelSellerLegalEntity: company, channelInvoiceProfile: null, storeSellerRequisites: null })
    expect(r?.companyName).toBe('ООО Продавец')
  })

  it('falls back to store requisites when the channel has none', () => {
    const r = resolveSellerRequisites({ channelSellerLegalEntity: null, channelInvoiceProfile: null, storeSellerRequisites: company })
    expect(r?.inn).toBe('7712345678')
  })

  it('overlays the invoice profile (VAT / signatories) onto the base identity', () => {
    const r = resolveSellerRequisites({
      channelSellerLegalEntity: company,
      channelInvoiceProfile: { vatEnabled: true, vatRate: 20, directorName: 'Иванов И.И.' },
      storeSellerRequisites: null,
    })
    expect(r?.vatEnabled).toBe(true)
    expect(r?.vatRate).toBe(20)
    expect(r?.directorName).toBe('Иванов И.И.')
  })

  it('returns null when the minimum (company + INN) is missing', () => {
    expect(resolveSellerRequisites({ channelSellerLegalEntity: null, channelInvoiceProfile: null, storeSellerRequisites: null })).toBeNull()
    expect(resolveSellerRequisites({ channelSellerLegalEntity: { companyName: 'X' }, channelInvoiceProfile: null, storeSellerRequisites: null })).toBeNull()
  })
})


it('profile cannot replace seller identity, contacts or bank', () => {
  const base = { ...company, bank: { name: 'Original', account: 'original-account' }, legalAddress: 'Original address', phone: 'original-phone' }
  const r = resolveSellerRequisites({ channelSellerLegalEntity: base, storeSellerRequisites: null,
    channelInvoiceProfile: { companyName: 'Other', inn: 'Other', bank: { account: 'Other' }, legalAddress: 'Other', phone: 'Other', vatEnabled: true, vatRate: 22, directorName: 'Allowed', paymentPurpose: 'Allowed purpose' } })
  expect(r).toMatchObject({ ...base, vatEnabled: true, vatRate: 22, directorName: 'Allowed', paymentPurpose: 'Allowed purpose' })
})
it('an incomplete selected seller does not silently mix with store identity', () => {
  expect(resolveSellerRequisites({ channelSellerLegalEntity: { companyName: 'Channel only' }, storeSellerRequisites: company, channelInvoiceProfile: { inn: 'injected' } })).toBeNull()
  expect(resolveSellerRequisites({ channelSellerLegalEntity: { companyName: ' ', inn: ' ' }, storeSellerRequisites: null, channelInvoiceProfile: null })).toBeNull()
})
