import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEV_STORE_PROFILE,
  StoreProfileSchema,
  deploymentProfileToRuntime,
  loadStoreProfile,
  resetStoreProfileCache,
  toPublicProfile,
} from '@/lib/store-profile'

const deploymentProfile = {
  schemaVersion: 1,
  store: { code: 'acme', name: 'ACME Wholesale', baseUrl: 'https://shop.acme.test' },
  admin: { email: 'a@acme.test', name: 'Admin' },
  modules: ['commerce-core', 'commerce-b2b', 'invoices'],
  integration: { provider: 'one-c' },
}

afterEach(() => {
  resetStoreProfileCache()
  delete process.env.STORE_PROFILE_PATH
})

describe('StoreProfileSchema', () => {
  it('accepts a valid profile', () => {
    expect(() => StoreProfileSchema.parse(DEV_STORE_PROFILE)).not.toThrow()
  })

  it('rejects a profile missing identity.name', () => {
    const bad = { ...DEV_STORE_PROFILE, identity: { code: 'x', name: '' } }
    expect(() => StoreProfileSchema.parse(bad)).toThrow()
  })

  it('rejects an unknown ERP provider', () => {
    const bad = { ...DEV_STORE_PROFILE, integrations: { primaryErp: 'sap' } }
    expect(() => StoreProfileSchema.parse(bad)).toThrow()
  })
})

describe('deploymentProfileToRuntime', () => {
  it('maps the deployment shape into a runtime profile with defaults', () => {
    const p = deploymentProfileToRuntime(deploymentProfile)
    expect(p.identity).toEqual({ code: 'acme', name: 'ACME Wholesale', legalName: undefined })
    expect(p.modules).toEqual({ b2b: true, content: false, invoices: true })
    expect(p.integrations.primaryErp).toBe('one-c')
    // defaults
    expect(p.policies).toEqual({ catalogRequiresAuth: true, registration: 'manual', requireAgeConfirmation: true })
    expect(p.theme).toEqual({ id: 'acme', defaultPalette: 'violet' })
    expect(p.defaultChannelCode).toBe('DEFAULT')
  })

  it('honours a runtime override block', () => {
    const p = deploymentProfileToRuntime({
      ...deploymentProfile,
      runtime: { registration: 'auto', requireAgeConfirmation: false, themeId: 'custom', defaultPalette: 'blue', defaultChannelCode: 'MAIN' },
    })
    expect(p.policies.registration).toBe('auto')
    expect(p.policies.requireAgeConfirmation).toBe(false)
    expect(p.theme).toEqual({ id: 'custom', defaultPalette: 'blue' })
    expect(p.defaultChannelCode).toBe('MAIN')
  })

  it('falls back to custom for an unknown provider', () => {
    expect(deploymentProfileToRuntime({ ...deploymentProfile, integration: { provider: 'sap' } }).integrations.primaryErp).toBe('custom')
  })
})

describe('loadStoreProfile', () => {
  it('returns the dev default when no profile file exists', () => {
    process.env.STORE_PROFILE_PATH = path.join(os.tmpdir(), 'does-not-exist-profile.json')
    expect(loadStoreProfile()).toEqual(DEV_STORE_PROFILE)
  })

  it('reads and maps a profile file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'axima-')), 'store-profile.json')
    fs.writeFileSync(file, JSON.stringify(deploymentProfile))
    process.env.STORE_PROFILE_PATH = file
    expect(loadStoreProfile().identity.name).toBe('ACME Wholesale')
  })
})

describe('toPublicProfile', () => {
  it('exposes only the serializable subset plus the storage namespace', () => {
    const pub = toPublicProfile(DEV_STORE_PROFILE)
    expect(pub.identity).toEqual({ code: 'dev', name: 'AXIMA Commerce (dev)' })
    expect(pub.storageNamespace).toBe('axima-commerce')
    expect(pub).not.toHaveProperty('modules')
    expect(pub).not.toHaveProperty('integrations')
  })
})
