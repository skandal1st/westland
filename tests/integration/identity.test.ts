import { listBuyerLocations, createBuyerLocation, createBuyerLocationForStaff } from '@/lib/account/locations'
import { setBuyerDeliveryPoints } from '@/lib/account/location-access'
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
fs.writeFileSync(profileFile, JSON.stringify({ store: { code: CODE, name: 'Test Identity' }, modules: ['commerce-core', 'commerce-b2b'], integration: { provider: 'custom' } }))
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
  delete process.env.STORE_PROFILE_PATH
  resetStoreProfileCache()
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


describe('moderated delivery points', () => {
  it('approves only selected points, preserves existing requisites and isolates another account of the same customer', async () => {
    await prisma.appSettings.update({ where: { storeId }, data: { registrationMode: 'MANUAL_APPROVAL' } })
    const customer = await prisma.customer.create({ data: { storeId, inn: '262814584465', displayName: 'Verified IP', legalName: 'Verified legal name' } })
    const pointA = await prisma.customerLocation.create({ data: { customerId: customer.id, name: 'A', city: 'City', address: 'A street' } })
    const pointB = await prisma.customerLocation.create({ data: { customerId: customer.id, name: 'B', city: 'City', address: 'B street' } })
    const actor = await prisma.user.create({ data: { storeId, email: 'moderator@points.test', name: 'Moderator', role: 'STAFF', passwordHash: '!disabled' } })
    const request = await createRegistrationRequest({ email: 'points@buyer.test', password: 'password12', contactName: 'Buyer', legalName: 'Unverified changed name', inn: customer.inn })
    const approved = await approveRegistration(request.id, { actor, locationIds: [pointA.id, pointA.id] })
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: approved.createdUserId! } })
    expect(buyer.deliveryPointsRestricted).toBe(true)
    expect((await listBuyerLocations(buyer)).map(p => p.id)).toEqual([pointA.id])
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).legalName).toBe('Verified legal name')
    const secondRequest = await createRegistrationRequest({ email: 'points-second@buyer.test', password: 'password12', contactName: 'Second', legalName: 'Same IP', inn: customer.inn })
    const secondApproval = await approveRegistration(secondRequest.id, { actor, locationIds: [] })
    const second = await prisma.user.findUniqueOrThrow({ where: { id: secondApproval.createdUserId! } })
    expect(await listBuyerLocations(second)).toEqual([])
    const ownPoint = await createBuyerLocation(second, { name: 'New branch', city: 'City', address: 'New street' })
    expect((await listBuyerLocations(second)).map(p => p.id)).toEqual([ownPoint.id])
    expect((await listBuyerLocations(buyer)).map(p => p.id)).toEqual([pointA.id])
    expect(await prisma.userDeliveryPointGrant.findUnique({ where: { userId_locationId: { userId: second.id, locationId: ownPoint.id } } })).toMatchObject({ origin: 'SELF_CREATED', assignedById: second.id })
    expect(ownPoint.isDefault).toBe(true)
    const staffPoint = await createBuyerLocationForStaff(buyer.id, actor, { name: 'Manager branch', city: 'City', address: 'Manager street' })
    expect((await listBuyerLocations(buyer)).map(point => point.id)).toEqual([pointA.id, staffPoint.id])
    expect((await listBuyerLocations(second)).map(point => point.id)).toEqual([ownPoint.id])
    expect(await prisma.userDeliveryPointGrant.findUnique({ where: { userId_locationId: { userId: buyer.id, locationId: staffPoint.id } } })).toMatchObject({ origin: 'MODERATOR', assignedById: actor.id })
    expect(await prisma.auditEntry.count({ where: { storeId, targetId: staffPoint.id, action: 'StaffBuyerDeliveryPointCreated' } })).toBe(1)
    await setBuyerDeliveryPoints(buyer.id, [pointB.id], actor)
    expect((await listBuyerLocations(buyer)).map(p => p.id)).toEqual([pointB.id])
    await setBuyerDeliveryPoints(buyer.id, [], actor)
    expect(await listBuyerLocations(buyer)).toEqual([])
    expect(await prisma.auditEntry.count({ where: { storeId, targetId: buyer.id, action: 'BuyerDeliveryPointsAssigned' } })).toBe(2)
  })

  it('rejects foreign points and unauthorized assignment atomically', async () => {
    const actor = await prisma.user.findUniqueOrThrow({ where: { storeId_email: { storeId, email: 'moderator@points.test' } } })
    const customer = await prisma.customer.findUniqueOrThrow({ where: { storeId_inn: { storeId, inn: '262814584465' } } })
    const foreign = await prisma.customer.findUniqueOrThrow({ where: { storeId_inn: { storeId, inn: '7712345678' } } })
    const wrongPoint = await prisma.customerLocation.create({ data: { customerId: foreign.id, name: 'Other company', city: 'City', address: 'Street' } })
    const request = await createRegistrationRequest({ email: 'wrong-point@buyer.test', password: 'password12', contactName: 'Buyer', legalName: customer.legalName, inn: customer.inn })
    await expect(approveRegistration(request.id, { actor, locationIds: [wrongPoint.id] })).rejects.toMatchObject({ code: 'INVALID_DELIVERY' })
    expect((await prisma.registrationRequest.findUniqueOrThrow({ where: { id: request.id } })).status).toBe('PENDING')
    expect(await prisma.user.findFirst({ where: { storeId, email: request.email } })).toBeNull()
    const buyer = await prisma.user.findUniqueOrThrow({ where: { storeId_email: { storeId, email: 'points@buyer.test' } } })
    await expect(setBuyerDeliveryPoints(buyer.id, [wrongPoint.id], actor)).rejects.toMatchObject({ code: 'INVALID_DELIVERY' })
    await expect(setBuyerDeliveryPoints(buyer.id, [], buyer)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(createBuyerLocationForStaff(buyer.id, buyer, { name: 'Denied', city: 'City', address: 'Street' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(approveRegistration(request.id, { actor: null, locationIds: [wrongPoint.id] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(approveRegistration(request.id, { actor: buyer })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await listBuyerLocations(buyer)).toEqual([])
  })

  it('rejects another store moderator and mismatching KPP without changing customer data', async () => {
    const foreignStore = await prisma.store.create({ data: { slug: 'point-foreign-store', name: 'Foreign' } })
    try {
      const outsider = await prisma.user.create({ data: { storeId: foreignStore.id, email: 'foreign@points.test', name: 'Foreign', role: 'STAFF', passwordHash: '!disabled' } })
      const pending = await prisma.registrationRequest.findFirstOrThrow({ where: { storeId, email: 'wrong-point@buyer.test' } })
      await expect(approveRegistration(pending.id, { actor: outsider })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      const buyer = await prisma.user.findUniqueOrThrow({ where: { storeId_email: { storeId, email: 'points@buyer.test' } } })
      await expect(setBuyerDeliveryPoints(buyer.id, [], outsider)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      const actor = await prisma.user.findUniqueOrThrow({ where: { storeId_email: { storeId, email: 'moderator@points.test' } } })
      const request = await createRegistrationRequest({ email: 'wrong-kpp@buyer.test', password: 'password12', contactName: 'Buyer', legalName: 'Changed', inn: '262814584465', kpp: '123456789' })
      await expect(approveRegistration(request.id, { actor })).rejects.toMatchObject({ code: 'REQUISITES_MISMATCH' })
    } finally { await prisma.store.delete({ where: { id: foreignStore.id } }) }
  })
})
