import { CapabilityError } from '@/lib/capabilities'
import { resetStoreProfileCache } from '@/lib/store-profile'
import { submitOrder, cancelOrder } from '@/lib/orders/orders'
import { issueInvoice, getCurrentInvoice } from '@/lib/invoices/invoices'
import { getInvoicePdf } from '@/lib/invoices/pdf-service'
import { setMediaStore } from '@/lib/media'
import { enqueueJob, retryJob, runJob, JOB_CATALOG_IMPORT } from '@/lib/integrations/jobs'
import { runDueOrderExports } from '@/lib/integrations/order-export'
import { runWorkerTick } from '@/lib/integrations/worker'
import { importCatalog } from '@/lib/integrations/import-catalog'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
let connectionId: string
let channelId: string
let variantId: string
let deliveryId: string
let user: SessionUser

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lic-int-'))
const grantPath = path.join(dir, 'license.json')
const keyPath = path.join(dir, 'installation-private-key.pem')
const pubPath = path.join(dir, 'publisher-public.pem')

/** Write a license fixture; `valid=false` binds the grant to another identity. */
function writeLicense(valid: boolean, modules = ['commerce-core', 'commerce-b2b']) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publisherPriv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publisherPub = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const identity = generateInstallationIdentity()
  const envelope = signGrant(
    {
      schemaVersion: 1, licenseId: 'lic_int', customerId: 'cust_int',
      installationId: identity.installationId, installationPublicKeyThumbprint: identity.publicKeyThumbprint,
      deploymentClass: 'production', modules,
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

function setProfile(modules: string[]) {
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ store: { code: 'license-test', name: 'License Test' }, modules }))
  process.env.STORE_PROFILE_PATH = path.join(dir, 'profile.json')
  resetStoreProfileCache()
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

  writeLicense(true)
  const store = await prisma.store.create({ data: { slug: 'test-license', name: 'Test License' } })
  storeId = store.id
  connectionId = (await prisma.integrationConnection.create({ data: { storeId, name: 'License test', provider: 'CUSTOM', sourceState: 'ACTIVE', enabled: true, environment: 'TEST' } })).id
  await prisma.appSettings.create({ data: { storeId, invoicePrefix: 'TL' } })
  const book = await createPriceBook({ storeId, code: 'default', name: 'Base', isDefault: true }, prisma)
  await createPriceGroup({ storeId, code: 'retail', name: 'Retail', priceBookId: book.id }, prisma)
  const location = await createInventoryLocation({ storeId, code: 'L1', name: 'WH1' }, prisma)
  channelId = (await upsertFulfillmentChannel({ storeId, code: 'bank', name: 'Bank', paymentMethod: 'BANK_TRANSFER', inventoryLocationId: location.id, sellerLegalEntity: { companyName: 'Test seller', inn: '7712345678', bank: { name: 'Bank', bik: '044525225', account: '40702810900000000001', corAccount: '30101810400000000225' } }, invoiceProfile: { vatEnabled: true, vatRate: 20 } }, prisma)).id
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
  setProfile(['commerce-core', 'commerce-b2b', 'content', 'invoices', 'promotions'])
  writeLicense(true)
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
  delete process.env.STORE_PROFILE_PATH
  resetStoreProfileCache()
  setMediaStore(null)
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
    expect(view.lines[0].unitPrice).toBe('500.00')
  })

  it('recovers after reactivation (re-reading a valid grant restores writes)', async () => {
    writeLicense(false)
    await expect(checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: 'lic-x' })).rejects.toBeInstanceOf(LicenseError)
    writeLicense(true) // reactivation / restore installs a valid grant, then reload
    const order = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: 'lic-recovered' })
    expect(order.status).toBe('DRAFT')
  })
})

describe('R31/R32 commercial mutation boundaries', () => {
  const block = (kind: string) => {
    if (kind === 'INVALID') writeLicense(false)
    else if (kind === 'ABSENT') fs.unlinkSync(grantPath)
    else writeLicense(true, ['commerce-b2b', 'invoices']) // ACTIVE, but no core grant
  }

  it.each(['INVALID', 'ABSENT', 'NO_CORE'])('%s blocks submit, imports and export before claims or provider IO', async kind => {
    const order = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: 'guard-' + kind })
    const job = await enqueueJob({ storeId, connectionId, type: JOB_CATALOG_IMPORT }, prisma)
    const pullProducts = vi.fn(async () => ({ items: [] }))
    const provider = { ...createMockProvider({ products: [] }), pullProducts }
    const resolveProvider = vi.fn(() => provider)
    const before = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    block(kind)
    const code = kind === 'NO_CORE' ? 'capability_unavailable' : 'license_' + kind.toLowerCase()
    await expect(submitOrder(user, order.id, prisma)).rejects.toThrow(code)
    await expect(runJob(job, { resolveProvider }, prisma)).rejects.toThrow(code)
    await expect(retryJob(job.id, prisma)).rejects.toThrow(code)
    await expect(runDueOrderExports({ storeId, resolveProvider }, prisma)).rejects.toThrow(code)
    await expect(runWorkerTick({ storeId, resolveProvider }, prisma)).rejects.toThrow(code)
    await expect(importCatalog({ storeId, connectionId, provider }, prisma)).rejects.toThrow(code)
    expect(resolveProvider).not.toHaveBeenCalled()
    expect(pullProducts).not.toHaveBeenCalled()
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(before)
    expect(await prisma.orderExport.count({ where: { orderId: order.id } })).toBe(0)
    expect(await prisma.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: 'PENDING', attempts: 0, leaseToken: null })
    expect(await prisma.integrationAttempt.count({ where: { jobId: job.id } })).toBe(0)
    expect((await cancelOrder(user, order.id, prisma)).order.status).toBe('CANCELLED')
    writeLicense(true)
    expect((await runJob(job, { resolveProvider }, prisma)).status).toBe('succeeded')
  })

  it.each(['grant', 'profile'] as const)('B2B cannot be bypassed by direct checkout when missing from %s', async source => {
    if (source === 'grant') writeLicense(true, ['commerce-core'])
    else setProfile(['commerce-core', 'invoices'])
    const before = await prisma.order.count({ where: { storeId } })
    await expect(checkout(user, { deliveryLocationId: deliveryId })).rejects.toBeInstanceOf(CapabilityError)
    expect(await prisma.order.count({ where: { storeId } })).toBe(before)
    expect((await getCartView(user)).lines).toHaveLength(1)
  })

  it('invoice issuance/reissue requires its module; historical PDF can be rebuilt after license loss', async () => {
    writeLicense(true, ['commerce-core', 'commerce-b2b', 'invoices'])
    const order = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: 'licensed-invoice' })
    await submitOrder(user, order.id, prisma)
    // Synthetic provider confirmation: never a real ERP acceptance claim.
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CONFIRMED' } })
    await prisma.orderExport.update({ where: { orderId: order.id }, data: { confirmedAt: new Date(), externalId: 'synthetic-' + order.id } })
    writeLicense(true) // no invoices grant
    await expect(issueInvoice({ storeId, orderId: order.id, actor: user }, prisma)).rejects.toBeInstanceOf(CapabilityError)
    expect(await getCurrentInvoice({ storeId, orderId: order.id }, prisma)).toBeNull()
    writeLicense(true, ['commerce-core', 'commerce-b2b', 'invoices'])
    setProfile(['commerce-core', 'commerce-b2b']) // invoices disabled locally
    await expect(issueInvoice({ storeId, orderId: order.id, actor: user }, prisma)).rejects.toBeInstanceOf(CapabilityError)
    setProfile(['commerce-core', 'commerce-b2b', 'invoices'])
    const invoice = await issueInvoice({ storeId, orderId: order.id, actor: user }, prisma)
    const bytes = new Map<string, Buffer>()
    setMediaStore({
      get: async key => bytes.get(key) ?? null,
      put: async (key, data) => { bytes.set(key, data); return { key } },
      exists: async key => bytes.has(key),
    })
    writeLicense(false)
    await expect(issueInvoice({ storeId, orderId: order.id, actor: user, expectedVersion: 1 }, prisma)).rejects.toBeInstanceOf(LicenseError)
    const current = await getCurrentInvoice({ storeId, orderId: order.id }, prisma)
    expect(current?.id).toBe(invoice.id)
    expect((await getInvoicePdf(current!, prisma)).subarray(0, 4).toString()).toBe('%PDF')
    expect(await prisma.invoice.count({ where: { orderId: order.id } })).toBe(1)
    setMediaStore(null)
  })
})
