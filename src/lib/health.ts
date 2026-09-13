import fs from 'node:fs'
import path from 'node:path'
import { prisma } from '@/lib/db'
import { loadStoreProfile } from '@/lib/store-profile'

export type HealthStatus = {
  status: 'ok' | 'degraded'
  app: 'ok'
  db: 'ok' | 'down'
  profile: { code: string; name: string }
  // M1 reports license presence only. Cryptographic validation and runtime
  // enforcement are M10 — absence here never blocks or degrades the app.
  license: 'present' | 'absent'
  time: string
}

function licensePresent(): boolean {
  try {
    const file = process.env.LICENSE_GRANT_PATH || path.join(process.cwd(), 'deployment', 'config', 'license.json')
    return fs.existsSync(file)
  } catch {
    return false
  }
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
    license: licensePresent() ? 'present' : 'absent',
    time: new Date().toISOString(),
  }
}
