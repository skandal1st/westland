import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
// One implementation for install-time and tests — see scripts/bootstrap.mjs.
// @ts-expect-error — plain .mjs module without type declarations.
import { bootstrap } from '../../scripts/bootstrap.mjs'

const prisma = new PrismaClient()
const CODE = 'test-bootstrap'

async function cleanup() {
  const store = await prisma.store.findUnique({ where: { slug: CODE } })
  if (store) await prisma.store.delete({ where: { id: store.id } })
}

describe('bootstrap (integration)', () => {
  beforeAll(cleanup)
  afterAll(async () => {
    await cleanup()
    await prisma.$disconnect()
  })

  it('creates store, settings and the initial admin, then is idempotent', async () => {
    const first = await bootstrap(prisma, {
      store: { code: CODE, name: 'Test Store' },
      settings: { registration: 'manual', requireAgeConfirmation: true, catalogRequiresAuth: true },
      admin: { email: 'admin@test.local', name: 'Admin', password: 'secret-password' },
    })
    expect(first.adminCreated).toBe(true)

    const settings = await prisma.appSettings.findUnique({ where: { storeId: first.storeId } })
    expect(settings?.registrationMode).toBe('MANUAL_APPROVAL')
    expect(settings?.catalogRequiresAuth).toBe(true)

    // Re-run: no second admin, still exactly one store and one admin.
    const second = await bootstrap(prisma, {
      store: { code: CODE, name: 'Test Store Renamed' },
      settings: { registration: 'manual' },
      admin: { email: 'other@test.local', name: 'Other', password: 'another-password' },
    })
    expect(second.adminCreated).toBe(false)
    expect(second.storeId).toBe(first.storeId)

    const stores = await prisma.store.count({ where: { slug: CODE } })
    const admins = await prisma.user.count({ where: { storeId: first.storeId, role: 'ADMIN' } })
    expect(stores).toBe(1)
    expect(admins).toBe(1)

    // Upsert updated the store name on re-run.
    const store = await prisma.store.findUnique({ where: { id: first.storeId } })
    expect(store?.name).toBe('Test Store Renamed')
  })
})
