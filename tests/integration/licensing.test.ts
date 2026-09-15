import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { generateInstallationIdentity, signGrant } from '../../packages/license-core/index.mjs'
import { createInventoryLocation, createPriceBook, createPriceGroup, upsertFulfillmentChannel } from '@/lib/pricing/setup'
import { projectChannelAvailability } from '@/lib/pricing/availability'
import { setCartItem, setCartChannel, getCartView, clearCart } from '@/lib/cart/cart'
import { checkout } from '@/lib/cart/checkout'
import { reloadLicenseState, resetLicenseCache, LicenseError } from '@/lib/license'
import type { SessionUser } from '@/lib/authz'

const prisma = new PrismaClient()
let storeId: string
let channelId: string
let variantId: string
let deliveryId: string
let user: SessionUser

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-int-'))
const grantPath = path.join(dir, 'license.json')
const keyPath = path.join(dir, 'installation-private-key.pem')
const pubPath = path.join(dir, 'publisher-public.pem')

/** Write a license fixture; `valid=false` binds the grant to another identity. */
function writeLicense(valid: boolean) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publisherPriv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publisherPub = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const identity = generateInstallationIdentity()
  const envelope = signGrant(
    {
      schemaVersion: 1, licenseId: 'lic_int', customerId: 'cust_int',
      installationId: identity.installationId, installationPublicKeyThumbprint: identity.publicKeyThumbprint,
      deploymentClass: 'production', modules: ['commerce-core', 'commerce-b2b'],
      release: { channel: 'stable' }, issuedAt: new Date().toISOString(), runtimeExpiresAt: null,
    },
    publisherPriv,
    'publisher-int',
  )
  fs.writeFileSync(grantPath, JSON.stringify(envelope))
  // For an invalid state, store a key that does NOT match the grant (copied deployment).
  fs.writeFileSync(keyPath, valid ? identity.privateKeyPem : generateInstallationIdentity().privateKeyPem)
  fs.writeFileSync(pubPath, publisherPub)
  reloadLicenseState()
}

async function cleanup() {
  const store = await prisma.store.findUnique({ where: { slug: 'test-license' } })
  if (store) {
    await prisma.order.deleteMany({ where: { storeId: store.id } })
    await prisma.store.delete({ where: { id: store.id } })
  }
}

beforeAll(async () => {
  await cleanup()
  process.env.LICENSE_ENFORCE = '1'
  process.env.LICENSE_GRANT_PATH = grantPath
  process.env.LICENSE_INSTALLATION_KEY_PATH = keyPath
  process.env.LICENSE_PUBLISHER_PUBLIC_KEY_PATH = pubPath

  const store = await prisma.store.create({ data: { slug: 'test-license', name: 'Test License' } })
  storeId = store.id
  await prisma.appSettings.create({ data: { storeId, invoicePrefix: 'TL' } })
  const book = await createPriceBook({ storeId, code: 'default', name: 'Base', isDefault: true }, prisma)
  await createPriceGroup({ storeId, code: 'retail', name: 'Retail', priceBookId: book.id }, prisma)
  const location = await createInventoryLocation({ storeId, code: 'L1', name: 'WH1' }, prisma)
  channelId = (await upsertFulfillmentChannel({ storeId, code: 'bank', name: 'Bank', paymentMethod: 'BANK_TRANSFER', inventoryLocationId: location.id }, prisma)).id
  const product = await prisma.product.create({ data: { storeId, canonicalName: 'Prod', status: 'ACTIVE' } })
  variantId = (await prisma.productVariant.create({ data: { storeId, productId: product.id, sku: 'LIC-1', packaging: '25 г' } })).id
  await prisma.priceEntry.create({ data: { priceBookId: book.id, variantId, amount: 500 } })
  await prisma.stock.create({ data: { variantId, locationId: location.id, available: 50 } })
  await projectChannelAvailability(channelId, prisma)
  const customer = await prisma.customer.create({ data: { storeId, displayName: 'B', legalName: 'ООО B', inn: '7712345678' } })
  deliveryId = (await prisma.customerLocation.create({ data: { customerId: customer.id, name: 'Т', address: 'ул', city: 'СПб', isDefault: true } })).id
  const buyer = await prisma.user.create({ data: { storeId, customerId: customer.id, email: 'l@test.local', passwordHash: 'x', name: 'B', role: 'BUYER', status: 'ACTIVE' } })
  user = { id: buyer.id, email: buyer.email, name: buyer.name, role: 'BUYER', status: 'ACTIVE', storeId, customerId: customer.id, priceGroupId: null }
})

beforeEach(async () => {
  await clearCart(user.id)
  await setCartChannel(user, channelId)
  await setCartItem(user, variantId, 1)
})

afterAll(async () => {
  await cleanup()
  delete process.env.LICENSE_ENFORCE
  delete process.env.LICENSE_GRANT_PATH
  delete process.env.LICENSE_INSTALLATION_KEY_PATH
  delete process.env.LICENSE_PUBLISHER_PUBLIC_KEY_PATH
  resetLicenseCache()
  fs.rmSync(dir, { recursive: true, force: true })
  await prisma.$disconnect()
})

describe('license runtime enforcement (integration)', () => {
  it('permits checkout under an ACTIVE license bound to this installation', async () => {
    writeLicense(true)
    const order = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: 'lic-ok' })
    expect(order.status).toBe('DRAFT')
  })

  it('blocks checkout under an INVALID (copied) license WITHOUT corrupting data; reads stay alive', async () => {
    writeLicense(false)
    const before = await prisma.order.count({ where: { storeId } })
    await expect(checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: 'lic-bad' })).rejects.toBeInstanceOf(LicenseError)
    // No partial order was written.
    expect(await prisma.order.count({ where: { storeId } })).toBe(before)
    // Storefront/read path is unaffected by the license block.
    const view = await getCartView(user)
    expect(view.lines).toHaveLength(1)
    expect(view.lines[0].unitPrice).toBe(500)
  })

  it('recovers after reactivation (re-reading a valid grant restores writes)', async () => {
    writeLicense(false)
    await expect(checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: 'lic-x' })).rejects.toBeInstanceOf(LicenseError)
    writeLicense(true) // reactivation / restore installs a valid grant, then reload
    const order = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: 'lic-recovered' })
    expect(order.status).toBe('DRAFT')
  })
})
