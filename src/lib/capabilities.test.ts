import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectiveCapabilities, INSTALLED_MODULES } from './capabilities'
import { DEV_STORE_PROFILE, type StoreProfile } from './store-profile'
import type { LicenseState } from './license'

beforeEach(() => vi.stubEnv('LICENSE_ENFORCE', '1'))
afterEach(() => vi.unstubAllEnvs())
const active: LicenseState = { status: 'ACTIVE', modules: [...INSTALLED_MODULES, 'unknown-plugin'] }

describe('installed ∩ licensed ∩ enabled', () => {
  it('cannot enable code absent from this image', () => {
    expect(effectiveCapabilities(active, DEV_STORE_PROFILE)).toEqual([...INSTALLED_MODULES].sort())
    expect(effectiveCapabilities(active, DEV_STORE_PROFILE, ['commerce-core', 'content'])).toEqual(['commerce-core', 'content'])
  })
  it.each(['INVALID', 'ABSENT'] as const)('%s has no effective capabilities', status => {
    expect(effectiveCapabilities({ ...active, status }, DEV_STORE_PROFILE)).toEqual([])
  })
  it.each(['commerce-b2b', 'content', 'invoices', 'promotions'] as const)('requires both grant and profile for %s', module => {
    const flag = module === 'commerce-b2b' ? 'b2b' : module
    const disabled: StoreProfile = { ...DEV_STORE_PROFILE, modules: { ...DEV_STORE_PROFILE.modules, [flag]: false } }
    expect(effectiveCapabilities(active, disabled)).not.toContain(module)
    expect(effectiveCapabilities({ ...active, modules: active.modules.filter(m => m !== module) }, DEV_STORE_PROFILE)).not.toContain(module)
  })
  it('core must be installed, licensed and enabled even for optional modules', () => {
    expect(effectiveCapabilities(active, DEV_STORE_PROFILE, ['invoices'])).toEqual([])
    expect(effectiveCapabilities({ ...active, modules: ['invoices'] }, DEV_STORE_PROFILE)).toEqual([])
    expect(effectiveCapabilities(active, { ...DEV_STORE_PROFILE, modules: { ...DEV_STORE_PROFILE.modules, core: false } })).toEqual([])
  })
  it('development bypasses licensing only, never installed/profile restrictions', () => {
    vi.stubEnv('LICENSE_ENFORCE', '0')
    expect(effectiveCapabilities({ status: 'ABSENT', modules: [] }, { ...DEV_STORE_PROFILE, modules: { ...DEV_STORE_PROFILE.modules, invoices: false } }, ['commerce-core', 'invoices'])).toEqual(['commerce-core'])
  })
})
