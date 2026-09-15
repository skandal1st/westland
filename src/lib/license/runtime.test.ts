import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { generateInstallationIdentity, signGrant } from '../../../packages/license-core/index.mjs'
import { computeLicenseState, type LicensePaths } from '@/lib/license/runtime'
import { assertLicenseActive, isModuleLicensed, LicenseError, type LicenseState } from '@/lib/license'

function publisher() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

/** Write a grant + identity + publisher key to a temp dir and return the paths. */
function fixture(over?: { wrongInstallation?: boolean; tamper?: boolean }): LicensePaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-'))
  const issuer = publisher()
  const identity = generateInstallationIdentity()
  const envelope = signGrant(
    {
      schemaVersion: 1, licenseId: 'lic_x', customerId: 'cust_x',
      installationId: identity.installationId, installationPublicKeyThumbprint: identity.publicKeyThumbprint,
      deploymentClass: 'production', modules: ['commerce-core', 'content'],
      release: { channel: 'stable' }, issuedAt: new Date().toISOString(), runtimeExpiresAt: null,
    },
    issuer.privateKey,
    'publisher-test',
  )
  if (over?.tamper) envelope.grant.modules.push('sneaky')
  const keyOwner = over?.wrongInstallation ? generateInstallationIdentity() : identity
  const paths: LicensePaths = {
    grantPath: path.join(dir, 'license.json'),
    installationKeyPath: path.join(dir, 'installation-private-key.pem'),
    publisherKeyPath: path.join(dir, 'publisher-public.pem'),
  }
  fs.writeFileSync(paths.grantPath, JSON.stringify(envelope))
  fs.writeFileSync(paths.installationKeyPath, keyOwner.privateKeyPem)
  fs.writeFileSync(paths.publisherKeyPath, issuer.publicKey)
  return paths
}

afterEach(() => { delete process.env.LICENSE_ENFORCE })

describe('license runtime state (offline verification)', () => {
  it('reports ACTIVE for a valid grant bound to this installation', () => {
    const state = computeLicenseState(fixture())
    expect(state.status).toBe('ACTIVE')
    expect(state.modules).toEqual(['commerce-core', 'content'])
  })

  it('reports ABSENT when no grant file exists', () => {
    const state = computeLicenseState({ grantPath: '/no/such/license.json', installationKeyPath: '/x', publisherKeyPath: '/y' })
    expect(state.status).toBe('ABSENT')
  })

  it('reports INVALID for a grant belonging to another installation (anti-copy)', () => {
    const state = computeLicenseState(fixture({ wrongInstallation: true }))
    expect(state.status).toBe('INVALID')
  })

  it('reports INVALID for a tampered grant', () => {
    const state = computeLicenseState(fixture({ tamper: true }))
    expect(state.status).toBe('INVALID')
  })
})

describe('license enforcement guard', () => {
  const active: LicenseState = { status: 'ACTIVE', modules: ['content'] }
  const invalid: LicenseState = { status: 'INVALID', modules: [] }

  it('is a no-op when enforcement is disabled (dev/test)', () => {
    delete process.env.LICENSE_ENFORCE
    expect(() => assertLicenseActive(invalid)).not.toThrow()
  })

  it('blocks a non-active license when enforcement is enabled', () => {
    process.env.LICENSE_ENFORCE = '1'
    expect(() => assertLicenseActive(active)).not.toThrow()
    expect(() => assertLicenseActive(invalid)).toThrow(LicenseError)
  })

  it('gates modules by the grant only when enforced', () => {
    delete process.env.LICENSE_ENFORCE
    expect(isModuleLicensed('anything', invalid)).toBe(true) // unenforced → open
    process.env.LICENSE_ENFORCE = '1'
    expect(isModuleLicensed('content', active)).toBe(true)
    expect(isModuleLicensed('invoices', active)).toBe(false)
  })
})
