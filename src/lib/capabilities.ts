import { resolveCapabilities } from '../../packages/license-core/index.mjs'
import { assertLicenseActive, isLicenseEnforced, reloadLicenseState, type LicenseState } from '@/lib/license'
import { loadStoreProfile, type StoreProfile } from '@/lib/store-profile'

/** Modules shipped in this application image; config/grants cannot install code. */
export const INSTALLED_MODULES = ['commerce-core', 'commerce-b2b', 'content', 'invoices', 'promotions'] as const
export type Capability = typeof INSTALLED_MODULES[number]

export class CapabilityError extends Error {
  constructor(public capability: string) {
    super('capability_unavailable')
    this.name = 'CapabilityError'
  }
}

/** All optional modules depend on commerce-core. Reads of existing records need no guard. */
export function effectiveCapabilities(
  state: LicenseState = reloadLicenseState(),
  profile: StoreProfile = loadStoreProfile(),
  installed: readonly string[] = INSTALLED_MODULES,
): string[] {
  const enabled = [
    ...(profile.modules.core !== false ? ['commerce-core'] : []),
    ...(profile.modules.b2b ? ['commerce-b2b'] : []),
    ...(profile.modules.content ? ['content'] : []),
    ...(profile.modules.invoices ? ['invoices'] : []),
    ...(profile.modules.promotions ? ['promotions'] : []),
  ]
  const licensed = isLicenseEnforced() ? state.status === 'ACTIVE' ? state.modules : [] : [...installed]
  const effective = resolveCapabilities({ installed: [...installed], licensed, enabled })
  return effective.includes('commerce-core') ? effective : []
}

export function assertCapability(capability: Capability): void {
  const state = reloadLicenseState()
  assertLicenseActive(state)
  if (!effectiveCapabilities(state).includes(capability)) throw new CapabilityError(capability)
}
