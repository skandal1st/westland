#!/usr/bin/env node
// Operator-only provisioning of additional administrators. Credentials enter through stdin.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

export async function createAdministrator(db, input) {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const password = input.password
  if (!input.storeCode || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
    || !name || name.length > 200 || typeof password !== 'string' || password.length < 12
    || Buffer.byteLength(password, 'utf8') > 72) throw Error('invalid_administrator_input')
  const passwordHash = await bcrypt.hash(password, 12)
  return db.$transaction(async tx => {
    const store = await tx.store.findUnique({ where: { slug: input.storeCode } })
    if (!store) throw Error('store_not_found')
    if (!await tx.user.findFirst({ where: { storeId: store.id, role: 'ADMIN', status: 'ACTIVE' } })) throw Error('technical_administrator_required')
    if (await tx.user.findFirst({ where: { storeId: store.id, email: { equals: email, mode: 'insensitive' } } })) throw Error('email_already_exists')
    const user = await tx.user.create({ data: { storeId: store.id, email, name, passwordHash, role: 'ADMIN', status: 'ACTIVE' } })
    await tx.auditEntry.create({ data: { storeId: store.id, action: 'AdministratorCreated', targetType: 'User', targetId: user.id,
      summary: 'Additional administrator created by server operator', metadata: { email, execution: 'server-cli' } } })
    return { id: user.id, email: user.email, role: user.role, store: store.slug }
  }, { isolationLevel: 'Serializable' })
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--stdin') throw Error('usage: create-admin.mjs --stdin; JSON fields: email, name, password')
  const profile = JSON.parse(fs.readFileSync(process.env.STORE_PROFILE_PATH || '/app/deployment/config/store-profile.json', 'utf8'))
  const raw = fs.readFileSync(0, 'utf8')
  if (Buffer.byteLength(raw) > 4096) throw Error('input_too_large')
  const input = JSON.parse(raw)
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['email', 'name', 'password'].includes(k))) throw Error('invalid_administrator_input')
  const db = new PrismaClient()
  try { console.log(JSON.stringify(await createAdministrator(db, { ...input, storeCode: profile.store?.code }))) }
  finally { await db.$disconnect() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  const safe = ['invalid_administrator_input', 'store_not_found', 'technical_administrator_required', 'email_already_exists', 'input_too_large']
  console.error(safe.includes(error.message) ? error.message : 'administrator_creation_failed')
  process.exitCode = 1
})

