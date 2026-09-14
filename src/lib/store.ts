import { prisma } from '@/lib/db'
import { loadStoreProfile } from '@/lib/store-profile'

/**
 * Resolve the single active store for this deployment.
 *
 * One deployment serves one store (see PLATFORM_FOUNDATION.md); the store row is
 * bound to the deployment profile by `slug == profile.identity.code`. All
 * store-scoped queries derive their storeId from here rather than trusting
 * client input.
 */
export async function getActiveStore() {
  const profile = loadStoreProfile()
  const store = await prisma.store.findUnique({ where: { slug: profile.identity.code } })
  if (!store) throw new Error(`Active store "${profile.identity.code}" is not bootstrapped; run the installer.`)
  return store
}
