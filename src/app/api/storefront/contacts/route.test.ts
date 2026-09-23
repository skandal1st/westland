import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ settings: vi.fn(), store: vi.fn() }))
vi.mock('@/lib/db', () => ({ prisma: { appSettings: { findUnique: mocks.settings } } }))
vi.mock('@/lib/store', () => ({ getActiveStore: mocks.store }))
import { GET } from './route'

beforeEach(() => { vi.clearAllMocks(); mocks.store.mockResolvedValue({ id: 'trusted-store' }) })
describe('public storefront contacts', () => {
  it('exposes only configured phone/email and never seller, bank or installation data', async () => {
    mocks.settings.mockResolvedValue({ sellerRequisites: { phone: '+7 (999) 123-45-67', email: 'sales@example.test', inn: '1234567890', legalAddress: 'Private address', bank: { account: 'private-account' } } })
    expect(await (await GET()).json()).toEqual({ phone: '+7 (999) 123-45-67', email: 'sales@example.test' })
    expect(mocks.settings).toHaveBeenCalledWith({ where: { storeId: 'trusted-store' }, select: { sellerRequisites: true } })
  })
  it.each([null, { sellerRequisites: {} }, { sellerRequisites: { phone: 'javascript:alert(1)', email: 'bad\n@example.test' } }])('returns no fabricated contacts when settings are absent or invalid', async settings => {
    mocks.settings.mockResolvedValue(settings)
    expect(await (await GET()).json()).toEqual({ phone: null, email: null })
  })
})
