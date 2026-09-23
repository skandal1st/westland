#!/usr/bin/env node
/**
 * Idempotent deployment bootstrap (M1).
 *
 * Creates ONLY the minimum a fresh deployment needs: the Store row, its
 * AppSettings (derived from profile policies) and the initial administrator.
 * Deliberately does NOT create FulfillmentChannel/InventoryLocation — that
 * domain model is fixed in M5 (see docs/AXIMA_COMMERCE_IMPLEMENTATION_PLAN.md).
 *
 * Idempotency guarantees (safe to re-run install.sh):
 *   - Store / AppSettings are upserted, never duplicated.
 *   - If ANY admin already exists for the store, no second admin is created.
 *
 * One implementation, two callers: install.sh runs the CLI; integration tests
 * import `bootstrap()` directly to prove idempotency.
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{
 *   store: { code: string, name: string },
 *   preserveExisting?: boolean,
 *   settings?: { registration?: 'manual'|'auto', requireAgeConfirmation?: boolean, catalogRequiresAuth?: boolean, invoicePrefix?: string },
 *   admin: { email: string, name?: string, password: string },
 * }} input
 */
export async function bootstrap(prisma, input) {
  if (!input?.store?.code || !input?.store?.name) throw new Error('bootstrap: store.code and store.name are required')
  if (!input?.admin?.email || !input?.admin?.password) throw new Error('bootstrap: admin.email and admin.password are required')

  const settings = input.settings ?? {}
  const registrationMode = settings.registration === 'auto' ? 'AUTO_APPROVE' : 'MANUAL_APPROVAL'
  const requireAgeConfirmation = settings.requireAgeConfirmation ?? true
  const catalogRequiresAuth = settings.catalogRequiresAuth ?? true
  const invoicePrefix = settings.invoicePrefix ?? (input.store.code.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3) || 'WS')

  const store = await prisma.store.upsert({
    where: { slug: input.store.code },
    update: input.preserveExisting ? {} : { name: input.store.name },
    create: { slug: input.store.code, name: input.store.name },
  })

  await prisma.appSettings.upsert({
    where: { storeId: store.id },
    update: input.preserveExisting ? {} : { registrationMode, requireAgeConfirmation, catalogRequiresAuth, invoicePrefix },
    create: { storeId: store.id, registrationMode, requireAgeConfirmation, catalogRequiresAuth, invoicePrefix },
  })

  // Guard: never create a second administrator on re-run.
  const existingAdmin = await prisma.user.findFirst({ where: { storeId: store.id, role: 'ADMIN' } })
  let adminCreated = false
  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(input.admin.password, 10)
    await prisma.user.upsert({
      where: { storeId_email: { storeId: store.id, email: input.admin.email } },
      update: { role: 'ADMIN', status: 'ACTIVE' },
      create: {
        storeId: store.id,
        email: input.admin.email,
        name: input.admin.name ?? 'Administrator',
        passwordHash,
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    })
    adminCreated = true
  }

  return { storeId: store.id, storeCode: store.slug, adminCreated, adminEmail: input.admin.email }
}

// --- CLI entry ---------------------------------------------------------------
async function main() {
  const file = process.env.STORE_PROFILE_PATH || path.join(process.cwd(), 'deployment', 'config', 'store-profile.json')
  if (!fs.existsSync(file)) throw new Error(`Store profile not found at ${file}; run the installer first`)
  const dp = JSON.parse(fs.readFileSync(file, 'utf8'))
  const rt = dp.runtime ?? {}

  const adminEmail = process.env.ADMIN_EMAIL || dp.admin?.email
  const adminPassword = process.env.ADMIN_PASSWORD
  if (!adminEmail) throw new Error('ADMIN_EMAIL (or profile admin.email) is required')
  if (!adminPassword) throw new Error('ADMIN_PASSWORD is required (never invent one); pass it via environment')

  const prisma = new PrismaClient()
  try {
    const result = await bootstrap(prisma, {
      store: { code: dp.store?.code, name: dp.store?.name },
      preserveExisting: process.argv.includes('--create-only'),
      settings: {
        registration: rt.registration,
        requireAgeConfirmation: rt.requireAgeConfirmation,
        catalogRequiresAuth: rt.catalogRequiresAuth,
        invoicePrefix: rt.invoicePrefix,
      },
      admin: { email: adminEmail, name: process.env.ADMIN_NAME || dp.admin?.name, password: adminPassword },
    })
    console.log(`Bootstrap complete: store=${result.storeCode} admin=${result.adminEmail} adminCreated=${result.adminCreated}`)
  } finally {
    await prisma.$disconnect()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('Bootstrap failed:', error.message)
    process.exit(1)
  })
}
