import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'
import { createRegistrationRequest, approveRegistration, rejectRegistration, RegistrationError } from '@/lib/registration'
import { suspendUser, reactivateUser } from '@/lib/users'
import { resetStoreProfileCache } from '@/lib/store-profile'

const CODE = 'test-identity'
const prisma = new PrismaClient()

// Domain modules read the profile lazily (first getActiveStore call), so it is
// enough to point STORE_PROFILE_PATH at a temp profile before the tests run.
const profileFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'axima-id-')), 'store-profile.json')
fs.writeFileSync(profileFile, JSON.stringify({ store: { code: CODE, name: 'Test Identity' }, modules: ['commerce-b2b'], integration: { provider: 'custom' } }))
process.env.STORE_PROFILE_PATH = profileFile

async function cleanup() {
  const store = await prisma.store.findUnique({ where: { slug: CODE } })
  if (store) await prisma.store.delete({ where: { id: store.id } })
}

let storeId: string

beforeAll(async () => {
  resetStoreProfileCache()
  await cleanup()
  const store = await prisma.store.create({ data: { slug: CODE, name: 'Test Identity' } })
  storeId = store.id
  await prisma.appSettings.create({ data: { storeId, registrationMode: 'MANUAL_APPROVAL' } })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('identity / B2B access (integration)', () => {
  it('registers pending, approves into an active login-capable buyer, and audits', async () => {
    const request = await createRegistrationRequest({
      email: 'Buyer@Test.local', password: 'super-secret-1', contactName: 'Иван', legalName: 'ООО Тест', inn: '7712345678',
    })
    expect(request.status).toBe('PENDING')
    // No user yet — request is separate from the activated account.
    expect(await prisma.user.findFirst({ where: { storeId, email: 'buyer@test.local' } })).toBeNull()

    await approveRegistration(request.id, { actor: null })

    const user = await prisma.user.findFirst({ where: { storeId, email: 'buyer@test.local' } })
    expect(user?.status).toBe('ACTIVE')
    expect(user?.role).toBe('BUYER')
    // Password carried over from the request and is valid for login.
    expect(await bcrypt.compare('super-secret-1', user!.passwordHash)).toBe(true)
    expect(await prisma.customer.findFirst({ where: { storeId, inn: '7712345678' } })).not.toBeNull()
    expect(await prisma.auditEntry.count({ where: { storeId, action: 'RegistrationApproved' } })).toBe(1)
  })

  it('blocks duplicate email and duplicate pending, and invalid INN', async () => {
    await expect(createRegistrationRequest({ email: 'buyer@test.local', password: 'x'.repeat(9), contactName: 'a', legalName: 'b', inn: '7712345678' }))
      .rejects.toMatchObject({ code: 'EMAIL_TAKEN' })

    await createRegistrationRequest({ email: 'pending@test.local', password: 'password12', contactName: 'a', legalName: 'b', inn: '7712345678' })
    await expect(createRegistrationRequest({ email: 'pending@test.local', password: 'password12', contactName: 'a', legalName: 'b', inn: '7712345678' }))
      .rejects.toMatchObject({ code: 'ALREADY_PENDING' })

    await expect(createRegistrationRequest({ email: 'bad-inn@test.local', password: 'password12', contactName: 'a', legalName: 'b', inn: '12' }))
      .rejects.toBeInstanceOf(RegistrationError)
  })

  it('rejects a request with a reason and audits', async () => {
    const request = await createRegistrationRequest({ email: 'reject@test.local', password: 'password12', contactName: 'a', legalName: 'b', inn: '7712345678' })
    const updated = await rejectRegistration(request.id, { actor: null, comment: 'нет договора' })
    expect(updated.status).toBe('REJECTED')
    expect(await prisma.auditEntry.count({ where: { storeId, action: 'RegistrationRejected' } })).toBe(1)
  })

  it('suspends and reactivates a user with audit; suspended cannot be ACTIVE', async () => {
    const user = await prisma.user.findFirst({ where: { storeId, email: 'buyer@test.local' } })
    await suspendUser(user!.id, { actor: null })
    expect((await prisma.user.findUnique({ where: { id: user!.id } }))?.status).toBe('SUSPENDED')
    await reactivateUser(user!.id, { actor: null })
    expect((await prisma.user.findUnique({ where: { id: user!.id } }))?.status).toBe('ACTIVE')
    expect(await prisma.auditEntry.count({ where: { storeId, action: 'UserSuspended' } })).toBe(1)
  })

  it('auto-approves when the store policy is AUTO_APPROVE', async () => {
    await prisma.appSettings.update({ where: { storeId }, data: { registrationMode: 'AUTO_APPROVE' } })
    const result = await createRegistrationRequest({ email: 'auto@test.local', password: 'password12', contactName: 'Auto', legalName: 'ООО Авто', inn: '5501234567' })
    expect(result.status).toBe('APPROVED')
    expect(await prisma.user.findFirst({ where: { storeId, email: 'auto@test.local' } })).not.toBeNull()
  })
})
