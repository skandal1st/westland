import { afterAll, describe, expect, it } from 'vitest'
import { checkHealth } from '@/lib/health'
import { prisma } from '@/lib/db'

/**
 * Integration: the baseline migration is applied (by scripts/test-db-setup.mjs)
 * and the health probe reports the database as reachable. This proves the M0
 * gate — a clean database migrates and the app can talk to it.
 */
describe('health (integration)', () => {
  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('reports ok against a migrated database', async () => {
    const health = await checkHealth()
    expect(health.app).toBe('ok')
    expect(health.db).toBe('ok')
    expect(health.status).toBe('ok')
  })

  it('has the baseline schema applied', async () => {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'Store'
    `
    expect(Number(rows[0].count)).toBe(1)
  })
})
