import { beforeAll, afterAll, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { createAdministrator } from '../../scripts/create-admin.mjs'

const db = new PrismaClient(), code = 'test-additional-admin'
let storeId: string, originalId: string, originalHash: string
beforeAll(async () => {
  await db.store.deleteMany({ where: { slug: code } })
  const store = await db.store.create({ data: { slug: code, name: 'Admin provisioning test' } })
  storeId = store.id
  originalHash = await bcrypt.hash('original-password-123', 10)
  const admin = await db.user.create({ data: { storeId, email: 'technical@example.test', name: 'Technical', passwordHash: originalHash, role: 'ADMIN', status: 'ACTIVE' } })
  originalId = admin.id
})
afterAll(async () => { await db.store.deleteMany({ where: { slug: code } }); await db.$disconnect() })

it('creates an independent customer administrator and preserves the technical login', async () => {
  const created = await createAdministrator(db, { storeCode: code, email: ' Client@Example.test ', name: 'Client', password: 'client-password-123' })
  expect(created.email).toBe('client@example.test')
  expect(await db.user.count({ where: { storeId, role: 'ADMIN', status: 'ACTIVE' } })).toBe(2)
  expect((await db.user.findUniqueOrThrow({ where: { id: originalId } })).passwordHash).toBe(originalHash)
  expect(await bcrypt.compare('client-password-123', (await db.user.findUniqueOrThrow({ where: { id: created.id } })).passwordHash)).toBe(true)
  const audit = await db.auditEntry.findFirstOrThrow({ where: { storeId, action: 'AdministratorCreated' } })
  expect(JSON.stringify(audit)).not.toContain('client-password')
  expect(JSON.stringify(audit)).not.toContain(originalHash)
})

it('refuses collisions and does not reset an existing password or upgrade a buyer', async () => {
  await expect(createAdministrator(db, { storeCode: code, email: 'TECHNICAL@example.test', name: 'Replace', password: 'replacement-password' })).rejects.toThrow('email_already_exists')
  const buyer = await db.user.create({ data: { storeId, email: 'buyer@example.test', name: 'Buyer', passwordHash: originalHash, role: 'BUYER', status: 'ACTIVE' } })
  await expect(createAdministrator(db, { storeCode: code, email: buyer.email, name: 'Buyer', password: 'replacement-password' })).rejects.toThrow('email_already_exists')
  expect((await db.user.findUniqueOrThrow({ where: { id: buyer.id } })).role).toBe('BUYER')
  expect((await db.user.findUniqueOrThrow({ where: { id: originalId } })).passwordHash).toBe(originalHash)
})

it('rejects a missing store, absent technical administrator and bcrypt-truncated passwords', async () => {
  const input = { storeCode: 'missing-admin-store', email: 'x@example.test', name: 'X', password: 'valid-password-123' }
  await expect(createAdministrator(db, input)).rejects.toThrow('store_not_found')
  await expect(createAdministrator(db, { ...input, storeCode: code, password: 'я'.repeat(40) })).rejects.toThrow('invalid_administrator_input')
  await db.user.updateMany({ where: { storeId, role: 'ADMIN' }, data: { status: 'SUSPENDED' } })
  await expect(createAdministrator(db, { ...input, storeCode: code })).rejects.toThrow('technical_administrator_required')
})

