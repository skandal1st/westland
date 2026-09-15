import { getLicenseState, isLicenseEnforced, type LicenseState, type LicenseStatus } from '@/lib/license/runtime'

export { getLicenseState, reloadLicenseState, resetLicenseCache, computeLicenseState, isLicenseEnforced } from '@/lib/license/runtime'
export type { LicenseState, LicenseStatus, LicensePaths } from '@/lib/license/runtime'

/** Thrown by domain services when a mutating action is blocked by license state. */
export class LicenseError extends Error {
  constructor(public status: LicenseStatus, public reason?: string) {
    super(`license_${status.toLowerCase()}`)
    this.name = 'LicenseError'
  }
}

/**
 * Guard for mutating domain operations. No-op unless enforcement is on (prod or
 * LICENSE_ENFORCE=1). When enforced, anything other than an ACTIVE license
 * blocks the write — reads and the storefront stay available, so a copied or
 * unlicensed deployment degrades in a controlled way without data corruption.
 */
export function assertLicenseActive(state: LicenseState = getLicenseState()): void {
  if (!isLicenseEnforced()) return
  if (state.status !== 'ACTIVE') throw new LicenseError(state.status, state.reason)
}

/** True when the given license module id is covered by the active grant. */
export function isModuleLicensed(moduleId: string, state: LicenseState = getLicenseState()): boolean {
  if (!isLicenseEnforced()) return true
  return state.status === 'ACTIVE' && state.modules.includes(moduleId)
}
