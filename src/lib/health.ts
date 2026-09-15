import { prisma } from '@/lib/db'
import { loadStoreProfile } from '@/lib/store-profile'
import { getLicenseState, isLicenseEnforced } from '@/lib/license'

export type HealthStatus = {
  status: 'ok' | 'degraded'
  app: 'ok'
  db: 'ok' | 'down'
  profile: { code: string; name: string }
  // M10: cryptographically validated license status. Enforcement only blocks
  // mutations (never reads/health); an invalid license does not degrade health.
  license: { status: 'ACTIVE' | 'INVALID' | 'ABSENT'; enforced: boolean }
  time: string
}

/**
 * Liveness + readiness in one probe. The app process is considered live if this
 * handler runs at all; readiness depends on the database. A DB outage returns
 * `degraded` (503 at the route layer) without crashing the app — this invariant
 * is reused by later milestones (an ERP/provider outage must not take the
 * storefront down, and neither should a transient DB blip crash the process).
 */
export async function checkHealth(): Promise<HealthStatus> {
  let db: 'ok' | 'down' = 'down'
  try {
    await prisma.$queryRaw`SELECT 1`
    db = 'ok'
  } catch {
    db = 'down'
  }
  const profile = loadStoreProfile()
  return {
    status: db === 'ok' ? 'ok' : 'degraded',
    app: 'ok',
    db,
    profile: { code: profile.identity.code, name: profile.identity.name },
    license: { status: getLicenseState().status, enforced: isLicenseEnforced() },
    time: new Date().toISOString(),
  }
}
