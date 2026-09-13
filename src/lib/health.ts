import { prisma } from '@/lib/db'

export type HealthStatus = {
  status: 'ok' | 'degraded'
  app: 'ok'
  db: 'ok' | 'down'
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
  return {
    status: db === 'ok' ? 'ok' : 'degraded',
    app: 'ok',
    db,
    time: new Date().toISOString(),
  }
}
