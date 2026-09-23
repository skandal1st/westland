// Read-only deployment gate. /api/health intentionally remains a liveness check.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { PrismaClient, Prisma } from '@prisma/client'
import { verifyGrantEnvelope } from '../packages/license-core/index.mjs'
const prisma = new PrismaClient()
try {
  if (process.env.LICENSE_ENFORCE !== '1') throw Error('license enforcement must be enabled')
  if (!process.env.NEXTAUTH_SECRET || process.env.NEXTAUTH_SECRET.length < 32) throw Error('auth secret missing/too short')
  const url = new URL(process.env.NEXTAUTH_URL)
  if (url.protocol !== 'https:') throw Error('public URL must use HTTPS')
  const profile = JSON.parse(fs.readFileSync(process.env.STORE_PROFILE_PATH, 'utf8'))
  if (!profile.store?.code || !profile.store?.name || !Array.isArray(profile.modules) || !profile.modules.includes('commerce-core')) throw Error('invalid store profile')
  const envelope = JSON.parse(fs.readFileSync(process.env.LICENSE_GRANT_PATH, 'utf8'))
  const key = fs.readFileSync(process.env.LICENSE_INSTALLATION_KEY_PATH, 'utf8')
  const grant = verifyGrantEnvelope(envelope, { [envelope.keyId]: fs.readFileSync(process.env.LICENSE_PUBLISHER_PUBLIC_KEY_PATH, 'utf8') }, key)
  if (profile.modules.some(module => !grant.modules.includes(module))) throw Error('profile modules exceed license')
  const identity = JSON.parse(fs.readFileSync('/app/deployment/config/installation.json', 'utf8'))
  const publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString()
  if (identity.installationId !== grant.installationId || identity.publicKeyPem !== publicKey) throw Error('installation identity mismatch')
  const store = await prisma.store.findUnique({ where: { slug: profile.store.code }, include: { settings: true } })
  if (!store?.settings) throw Error('store/settings are not bootstrapped')
  const admin = await prisma.user.findFirst({ where: { storeId: store.id, role: 'ADMIN', status: 'ACTIVE' } })
  if (!admin?.passwordHash) throw Error('active administrator missing')
  const failed = await prisma.$queryRawUnsafe('SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL')
  if (failed[0].count !== 0) throw Error('unfinished migration')
  // All scalar columns in the image's own generated client must still be readable.
  // This is also run with the PREVIOUS image against the migrated disposable copy.
  for (const model of Prisma.dmmf.datamodel.models) {
    const delegate = model.name[0].toLowerCase() + model.name.slice(1)
    await prisma[delegate].findFirst()
  }
  if (!process.argv.includes('--database-copy')) {
    for (const dir of ['/app/exchange', '/app/.media']) fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK)
    const response = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(5000) })
    const health = await response.json()
    if (!response.ok || health.license?.status !== 'ACTIVE' || !health.license?.enforced) throw Error('runtime license/health not ready')
  }
  console.log(JSON.stringify({ deploymentReady: true, store: store.slug, license: 'ACTIVE', schemaModels: Prisma.dmmf.datamodel.models.length, salesAcceptance: 'separate R39 gate' }))
} catch (error) {
  // Do not print Prisma errors: they can contain customer data and connection details.
  console.error('Deployment readiness failed: ' + (error.code ? 'database contract' : error.message))
  process.exitCode = 1
} finally { await prisma.$disconnect() }
