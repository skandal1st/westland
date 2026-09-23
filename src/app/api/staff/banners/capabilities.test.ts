import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ session: vi.fn(), create: vi.fn(), list: vi.fn() }))
vi.mock('next-auth', () => ({ getServerSession: mocks.session }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/db', () => ({ prisma: { siteBanner: { create: mocks.create, findMany: mocks.list } } }))
vi.mock('@/lib/store', () => ({ getActiveStore: async () => ({ id: 'store' }) }))
vi.mock('@/lib/content/read', () => ({ invalidateContentCache: vi.fn() }))
import * as runtime from '@/lib/license/runtime'
import * as profile from '@/lib/store-profile'
import { GET, POST } from './route'
import { requireApiUser } from '@/lib/authz'
import type { LicenseState } from '@/lib/license'

const active: LicenseState = { status: 'ACTIVE', modules: ['commerce-core', 'content'] }
const request = () => new Request('http://localhost/api/staff/banners', { method: 'POST', body: JSON.stringify({ name: 'Offer' }) })
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('LICENSE_ENFORCE', '1')
  vi.spyOn(runtime, 'reloadLicenseState').mockReturnValue(active)
  vi.spyOn(profile, 'loadStoreProfile').mockReturnValue(profile.DEV_STORE_PROFILE)
  mocks.session.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN', storeId: 'store' } })
  mocks.create.mockResolvedValue({ id: 'banner' })
  mocks.list.mockResolvedValue([])
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it.each(['INVALID', 'ABSENT'] as const)('direct POST rejects %s without a write, while GET and recovery auth remain available', async status => {
  vi.mocked(runtime.reloadLicenseState).mockReturnValue({ status, modules: [] })
  const response = await POST(request())
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'license_' + status.toLowerCase() })
  expect(mocks.create).not.toHaveBeenCalled()
  expect((await GET()).status).toBe(200)
  expect(await requireApiUser(['ADMIN'])).toHaveProperty('user')
})
it.each(['unlicensed', 'disabled'] as const)('direct POST rejects %s content', async kind => {
  if (kind === 'unlicensed') vi.mocked(runtime.reloadLicenseState).mockReturnValue({ ...active, modules: ['commerce-core'] })
  else vi.mocked(profile.loadStoreProfile).mockReturnValue({ ...profile.DEV_STORE_PROFILE, modules: { ...profile.DEV_STORE_PROFILE.modules, content: false } })
  expect((await POST(request())).status).toBe(403)
  expect(mocks.create).not.toHaveBeenCalled()
})
it('reactivation restores the same endpoint', async () => {
  vi.mocked(runtime.reloadLicenseState).mockReturnValue({ status: 'ABSENT', modules: [] })
  expect((await POST(request())).status).toBe(403)
  vi.mocked(runtime.reloadLicenseState).mockReturnValue(active)
  expect((await POST(request())).status).toBe(201)
  expect(mocks.create).toHaveBeenCalledTimes(1)
})
it('auth and role checks precede capability inspection', async () => {
  mocks.session.mockResolvedValue(null)
  expect((await POST(request())).status).toBe(401)
  mocks.session.mockResolvedValue({ user: { role: 'BUYER' } })
  expect((await POST(request())).status).toBe(403)
  expect(runtime.reloadLicenseState).not.toHaveBeenCalled()
})
