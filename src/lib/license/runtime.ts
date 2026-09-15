import fs from 'node:fs'
import path from 'node:path'
import { createPublicKey, createPrivateKey } from 'node:crypto'
import { verifyGrantEnvelope, publicKeyThumbprint } from '../../../packages/license-core/index.mjs'
import type { LicenseEnvelope, LicenseGrant } from '../../../packages/license-core/index'

/**
 * Runtime license guard (plan §M10). The license is a perpetual, anti-copy
 * entitlement: a publisher-signed grant bound to THIS installation's identity,
 * fetched once at deploy time (install.mjs). At runtime we only VERIFY the
 * locally-stored grant offline — no network, no heartbeat, no expiry policy.
 *
 * Status is derived from files on disk and cached (the grant never changes at
 * runtime). Verification failure (tampered grant, or a grant belonging to a
 * different installation — i.e. a copied deployment) yields INVALID.
 *
 * This layer is isolated: domain code never imports license internals, only the
 * small assert/status surface re-exported from ./index.
 */
export type LicenseStatus = 'ACTIVE' | 'INVALID' | 'ABSENT'

export type LicenseState = {
  status: LicenseStatus
  reason?: string
  licenseId?: string
  customerId?: string
  installationId?: string
  deploymentClass?: string
  /** Licensed module ids from the grant; empty unless ACTIVE. */
  modules: string[]
}

export type LicensePaths = { grantPath: string; installationKeyPath: string; publisherKeyPath: string }

function defaultPaths(): LicensePaths {
  const base = process.cwd()
  return {
    grantPath: process.env.LICENSE_GRANT_PATH || path.join(base, 'deployment', 'config', 'license.json'),
    installationKeyPath: process.env.LICENSE_INSTALLATION_KEY_PATH || path.join(base, 'deployment', 'secrets', 'installation-private-key.pem'),
    publisherKeyPath: process.env.LICENSE_PUBLISHER_PUBLIC_KEY_PATH || path.join(base, 'deployment', 'config', 'publisher-public.pem'),
  }
}

/** Compute license state from disk. Pure w.r.t. the cache — used by reload/tests. */
export function computeLicenseState(paths: LicensePaths = defaultPaths()): LicenseState {
  if (!fs.existsSync(paths.grantPath)) return { status: 'ABSENT', reason: 'no license grant present', modules: [] }
  try {
    const envelope = JSON.parse(fs.readFileSync(paths.grantPath, 'utf8')) as LicenseEnvelope
    const installationPrivateKeyPem = fs.readFileSync(paths.installationKeyPath, 'utf8')
    const publisherPublicKeyPem = fs.readFileSync(paths.publisherKeyPath, 'utf8')
    const grant: LicenseGrant = verifyGrantEnvelope(envelope, { [envelope.keyId]: publisherPublicKeyPem }, installationPrivateKeyPem)
    // Defence in depth: confirm the installation key really matches the grant's
    // thumbprint (verifyGrantEnvelope already checks this, but keep it explicit).
    const localThumbprint = publicKeyThumbprint(
      createPublicKey(createPrivateKey(installationPrivateKeyPem)).export({ type: 'spki', format: 'pem' }).toString(),
    )
    if (localThumbprint !== grant.installationPublicKeyThumbprint) {
      return { status: 'INVALID', reason: 'installation identity mismatch', modules: [] }
    }
    return {
      status: 'ACTIVE',
      licenseId: grant.licenseId,
      customerId: grant.customerId,
      installationId: grant.installationId,
      deploymentClass: grant.deploymentClass,
      modules: grant.modules,
    }
  } catch (error) {
    return { status: 'INVALID', reason: (error as Error).message, modules: [] }
  }
}

let cache: LicenseState | null = null

/** Cached license state (perpetual grant → cache aggressively). */
export function getLicenseState(): LicenseState {
  if (!cache) cache = computeLicenseState()
  return cache
}

/** Force a re-read from disk (after reactivation / restore, and in tests). */
export function reloadLicenseState(): LicenseState {
  cache = computeLicenseState()
  return cache
}

export function resetLicenseCache(): void {
  cache = null
}

/**
 * Enforcement is opt-in so local dev and the test suite are not blocked by a
 * missing license. The installer sets LICENSE_ENFORCE=1 in production. When
 * enforced, only an ACTIVE license permits mutating operations.
 */
export function isLicenseEnforced(): boolean {
  return process.env.LICENSE_ENFORCE === '1' || process.env.NODE_ENV === 'production'
}
