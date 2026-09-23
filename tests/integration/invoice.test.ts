import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { getMediaStore, setMediaStore } from '@/lib/media'
import { getInvoicePdf, invoicePdfKey } from '@/lib/invoices/pdf-service'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetLicenseCache } from '@/lib/license'
import { PrismaClient } from '@prisma/client'
import { createInventoryLocation, createPriceBook, createPriceGroup, upsertFulfillmentChannel } from '@/lib/pricing/setup'
import { projectChannelAvailability } from '@/lib/pricing/availability'
import { setCartItem, setCartChannel } from '@/lib/cart/cart'
import { checkout } from '@/lib/cart/checkout'
import { submitOrder } from '@/lib/orders/orders'
import { issueInvoice, getCurrentInvoice, InvoiceError, sellerOf } from '@/lib/invoices/invoices'
import { renderInvoicePdf } from '@/lib/invoices/pdf'
import type { SessionUser } from '@/lib/authz'

const prisma = new PrismaClient()
let storeId: string
let channelId: string
let bareChannelId: string
let variantId: string
let deliveryId: string
let user: SessionUser
let counter = 0

const seller = { companyName: 'ООО Продавец', inn: '7712345678', kpp: '771201001', bank: { name: 'Банк', bik: '044525225', account: '40702810900000000001', corAccount: '30101810400000000225' } }

async function cleanup() {
  const store = await prisma.store.findUnique({ where: { slug: 'test-invoice' } })
  if (store) {
    await prisma.order.deleteMany({ where: { storeId: store.id } })
    await prisma.store.delete({ where: { id: store.id } })
  }
}

async function makeConfirmedOrder(channel = channelId, autoIssue = true) {
  await setCartChannel(user, channel)
  await setCartItem(user, variantId, 2)
  const draft = await checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: `inv-${counter++}` })
  await submitOrder(user, draft.id, prisma)
  expect(await getCurrentInvoice({ storeId, orderId: draft.id }, prisma)).toBeNull()
  // Explicit synthetic ERP-confirmation fixture; this is not real 1C acceptance.
  const confirmed = await prisma.order.update({ where: { id: draft.id }, data: { status: 'CONFIRMED' } })
  await prisma.orderExport.update({ where: { orderId: draft.id }, data: { externalId: 'test-erp-' + draft.id, confirmedAt: new Date() } })
  if (autoIssue && channel !== bareChannelId) await issueInvoice({ storeId, orderId: draft.id, actor: user }, prisma)
  return confirmed
}

beforeAll(async () => {
  await cleanup()
  const store = await prisma.store.create({ data: { slug: 'test-invoice', name: 'Test Invoice' } })
  storeId = store.id
  // Store-level requisites deliberately absent: requisites come from the channel.
  await prisma.appSettings.create({ data: { storeId, invoicePrefix: 'TI' } })
  const book = await createPriceBook({ storeId, code: 'default', name: 'Base', isDefault: true }, prisma)
  await createPriceGroup({ storeId, code: 'retail', name: 'Retail', priceBookId: book.id }, prisma)
  const location = await createInventoryLocation({ storeId, code: 'L1', name: 'WH1' }, prisma)
  channelId = (await upsertFulfillmentChannel({
    storeId, code: 'bank', name: 'Bank', paymentMethod: 'BANK_TRANSFER', inventoryLocationId: location.id,
    sellerLegalEntity: seller, invoiceProfile: { vatEnabled: true, vatRate: 20 },
  }, prisma)).id
  // A channel with NO seller requisites (and store has none) — issue must block.
  bareChannelId = (await upsertFulfillmentChannel({ storeId, code: 'cash', name: 'Cash', paymentMethod: 'CASH', inventoryLocationId: location.id }, prisma)).id

  const product = await prisma.product.create({ data: { storeId, canonicalName: 'Prod', status: 'ACTIVE' } })
  variantId = (await prisma.productVariant.create({ data: { storeId, productId: product.id, sku: 'SKU-1', packaging: 'кор' } })).id
  await prisma.priceEntry.create({ data: { priceBookId: book.id, variantId, amount: 100 } })
  await prisma.stock.create({ data: { variantId, locationId: location.id, available: 1000 } })
  await projectChannelAvailability(channelId, prisma)
  await projectChannelAvailability(bareChannelId, prisma)

  const customer = await prisma.customer.create({ data: { storeId, displayName: 'B', legalName: 'ООО Покупатель', inn: '7798765432', kpp: '779801001' } })
  deliveryId = (await prisma.customerLocation.create({ data: { customerId: customer.id, name: 'Склад', address: 'ул 1', city: 'СПб' } })).id
  const buyer = await prisma.user.create({ data: { storeId, customerId: customer.id, email: 'b@t.local', passwordHash: 'x', name: 'B', role: 'BUYER', status: 'ACTIVE' } })
  user = { id: buyer.id, email: buyer.email, name: buyer.name, role: 'BUYER', status: 'ACTIVE', storeId, customerId: customer.id, priceGroupId: null }
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('invoice / snapshot / PDF (integration)', () => {
  it('issues after ERP confirmation with an immutable snapshot of seller, buyer, VAT and lines', async () => {
    const order = await makeConfirmedOrder()
    const invoice = await getCurrentInvoice({ storeId, orderId: order.id }, prisma)
    expect(invoice).not.toBeNull()
    expect(invoice!.version).toBe(1)
    expect(invoice!.paymentMethod).toBe('BANK_TRANSFER')
    expect(invoice!.number).toBe(order.number)
    // VAT extracted from gross 200 @ 20%.
    expect(Number(invoice!.total)).toBe(200)
    expect(Number(invoice!.vatAmount)).toBe(33.33)
    expect(Number(invoice!.subtotal)).toBe(166.67)
    // Seller + buyer snapshotted.
    expect(sellerOf(invoice!)?.companyName).toBe('ООО Продавец')
    expect((invoice!.buyerSnapshot as { legalName: string }).legalName).toBe('ООО Покупатель')
    // Lines snapshotted from the order.
    expect(invoice!.lines).toHaveLength(1)
    expect(invoice!.lines[0]).toMatchObject({ sku: 'SKU-1', position: 1 })
    expect(Number(invoice!.lines[0].quantity)).toBe(2)
    expect(Number(invoice!.lines[0].lineTotal)).toBe(200)
  })

  it('changing seller requisites does NOT alter an already-issued invoice', async () => {
    const order = await makeConfirmedOrder()
    const before = await getCurrentInvoice({ storeId, orderId: order.id }, prisma)
    expect(sellerOf(before!)?.companyName).toBe('ООО Продавец')

    // Mutate the channel's seller requisites AFTER issue.
    await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { sellerLegalEntity: { ...seller, companyName: 'ООО Новое Имя' } } })

    const after = await prisma.invoice.findUnique({ where: { id: before!.id } })
    expect((after!.sellerSnapshot as { companyName: string }).companyName).toBe('ООО Продавец')

    // Restore for later tests.
    await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { sellerLegalEntity: seller } })
  })

  it('reissue creates a new version and VOIDs the previous one; the old snapshot is untouched', async () => {
    const order = await makeConfirmedOrder()
    const v1 = await getCurrentInvoice({ storeId, orderId: order.id }, prisma)
    expect(v1!.version).toBe(1)

    await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { sellerLegalEntity: { ...seller, companyName: 'ООО Переоформлено' } } })
    const v2 = await issueInvoice({ storeId, orderId: order.id, actor: user, expectedVersion: 1 }, prisma)
    expect(v2.version).toBe(2)
    expect(v2.number).toBe(`${order.number}-R2`)
    expect(sellerOf(v2)?.companyName).toBe('ООО Продавец')

    // Old row untouched + now VOID; current is v2.
    const old = await prisma.invoice.findUnique({ where: { id: v1!.id } })
    expect(old!.status).toBe('VOID')
    expect((old!.sellerSnapshot as { companyName: string }).companyName).toBe('ООО Продавец')
    const current = await getCurrentInvoice({ storeId, orderId: order.id }, prisma)
    expect(current!.id).toBe(v2.id)

    await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { sellerLegalEntity: seller } })
  })

  it('blocks issue with NO_SELLER_REQUISITES when neither channel nor store has them', async () => {
    const order = await makeConfirmedOrder(bareChannelId)
    // Confirmation cannot compensate for missing requisites.
    expect(await getCurrentInvoice({ storeId, orderId: order.id }, prisma)).toBeNull()
    await expect(issueInvoice({ storeId, orderId: order.id, actor: user }, prisma)).rejects.toMatchObject({ code: 'NO_SELLER_REQUISITES' })
    await expect(issueInvoice({ storeId, orderId: order.id, actor: user }, prisma)).rejects.toBeInstanceOf(InvoiceError)
  })

  it('renders the immutable snapshot to a non-empty PDF', async () => {
    const order = await makeConfirmedOrder()
    const invoice = await getCurrentInvoice({ storeId, orderId: order.id }, prisma)
    const pdf = await renderInvoicePdf(invoice!)
    expect(pdf.length).toBeGreaterThan(1000)
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })
})


it('invoice keeps the source article snapshot while order export retains the internal SKU', async () => {
  await prisma.productVariant.update({ where: { id: variantId }, data: { sourceSku: '000-ARTICLE' } })
  try {
    const order = await makeConfirmedOrder()
    expect(await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({ sku: 'SKU-1', sourceSku: '000-ARTICLE' })
    const invoice = await getCurrentInvoice({ storeId, orderId: order.id }, prisma)
    expect(invoice!.lines[0].sku).toBe('000-ARTICLE')
    await prisma.productVariant.update({ where: { id: variantId }, data: { sourceSku: 'CHANGED' } })
    const reissued = await issueInvoice({ storeId, orderId: order.id, actor: user, expectedVersion: 1 }, prisma)
    expect(reissued.lines[0].sku).toBe('000-ARTICLE')
  } finally { await prisma.productVariant.update({ where: { id: variantId }, data: { sourceSku: null } }) }
})


it('cash invoices omit transfer instructions and keep their method after channel changes', async () => {
  const channel=await prisma.fulfillmentChannel.findUniqueOrThrow({where:{id:channelId}})
  const cash=await upsertFulfillmentChannel({storeId,code:'cash-with-seller',name:'Cash',paymentMethod:'CASH',inventoryLocationId:channel.inventoryLocationId,
    sellerLegalEntity:{...seller,paymentPurpose:'Only for bank transfer'},invoiceProfile:{vatEnabled:true,vatRate:22}},prisma)
  const order=await makeConfirmedOrder(cash.id)
  const invoice=(await getCurrentInvoice({storeId,orderId:order.id},prisma))!
  expect(invoice.paymentMethod).toBe('CASH')
  expect(sellerOf(invoice)?.companyName).toBe(seller.companyName)
  expect(sellerOf(invoice)?.bank).toBeUndefined()
  expect(sellerOf(invoice)?.paymentPurpose).toBeUndefined()
  await prisma.fulfillmentChannel.update({where:{id:cash.id},data:{paymentMethod:'BANK_TRANSFER'}})
  const reissued=await issueInvoice({storeId,orderId:order.id,actor:user,expectedVersion:1},prisma)
  expect(reissued.paymentMethod).toBe('CASH')
  expect(sellerOf(reissued)?.bank).toBeUndefined()
  if(process.env.AXIMA_INVOICE_QA_DIR){fs.mkdirSync(process.env.AXIMA_INVOICE_QA_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.AXIMA_INVOICE_QA_DIR,'cash.pdf'),await renderInvoicePdf(invoice))}
})

it('cash invoice issues with seller identity and no bank details',async()=>{
  const channel=await prisma.fulfillmentChannel.findUniqueOrThrow({where:{id:channelId}})
  const cash=await upsertFulfillmentChannel({storeId,code:'cash-no-bank',name:'Cash',paymentMethod:'CASH',inventoryLocationId:channel.inventoryLocationId,
    sellerLegalEntity:{companyName:seller.companyName,inn:seller.inn}},prisma)
  const order=await makeConfirmedOrder(cash.id)
  expect((await getCurrentInvoice({storeId,orderId:order.id},prisma))?.paymentMethod).toBe('CASH')
})

it.each([undefined,{name:'Bank',bik:'123',account:'bad',corAccount:'bad'},{...seller.bank,corAccount:''}])('blocks incomplete/invalid bank details before persisting an invoice: %j',async bank=>{
  const channel=await prisma.fulfillmentChannel.findUniqueOrThrow({where:{id:channelId}})
  const variant=await upsertFulfillmentChannel({storeId,code:'bank-invalid-'+counter++,name:'Invalid bank',paymentMethod:'BANK_TRANSFER',inventoryLocationId:channel.inventoryLocationId,
    sellerLegalEntity:{companyName:seller.companyName,inn:seller.inn,...(bank?{bank}:{})}},prisma)
  const order=await makeConfirmedOrder(variant.id,false)
  await expect(issueInvoice({storeId,orderId:order.id,actor:user},prisma)).rejects.toMatchObject({code:'NO_BANK_REQUISITES'})
  expect(await prisma.invoice.count({where:{orderId:order.id}})).toBe(0)
})

it('keeps bank instructions and bank method from the accepted order snapshot',async()=>{
  const order=await makeConfirmedOrder()
  await prisma.fulfillmentChannel.update({where:{id:channelId},data:{paymentMethod:'CASH'}})
  try {
    const invoice=await issueInvoice({storeId,orderId:order.id,actor:user,expectedVersion:1},prisma)
    expect(invoice.paymentMethod).toBe('BANK_TRANSFER')
    expect(sellerOf(invoice)?.bank).toEqual(seller.bank)
    if(process.env.AXIMA_INVOICE_QA_DIR){fs.mkdirSync(process.env.AXIMA_INVOICE_QA_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.AXIMA_INVOICE_QA_DIR,'bank.pdf'),await renderInvoicePdf(invoice))}
  } finally {await prisma.fulfillmentChannel.update({where:{id:channelId},data:{paymentMethod:'BANK_TRANSFER'}})}
})


it('rebuilds a lost PDF from immutable invoice data and separates reissued versions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-invoice-cache-'))
  const previousRoot = process.env.MEDIA_ROOT
  process.env.MEDIA_ROOT = root
  setMediaStore(null)
  try {
    const order = await makeConfirmedOrder()
    const invoice = (await getCurrentInvoice({ storeId, orderId: order.id }, prisma))!
    const first = await getInvoicePdf(invoice, prisma)
    const key = invoicePdfKey(invoice)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).pdfPath).toBe(key)
    setMediaStore(null)
    expect(await getInvoicePdf(invoice, prisma)).toEqual(first)
    fs.unlinkSync(path.join(root, key))
    await prisma.customer.update({ where: { id: user.customerId! }, data: { legalName: 'Edited after invoice' } })
    const restored = await getInvoicePdf(invoice, prisma)
    expect(restored.subarray(0, 5).toString()).toBe('%PDF-')
    expect(await getMediaStore().get(key)).toEqual(restored)
    expect((await getCurrentInvoice({ storeId, orderId: order.id }, prisma))!.buyerSnapshot).toEqual(invoice.buyerSnapshot)
    const next = await issueInvoice({ storeId, orderId: order.id, actor: user, expectedVersion: 1 }, prisma)
    expect(invoicePdfKey(next)).not.toBe(key)
    await getInvoicePdf(next, prisma)
    expect(fs.readdirSync(path.join(root, 'invoices')).sort()).toEqual([path.basename(key), path.basename(invoicePdfKey(next))].sort())
  } finally {
    setMediaStore(null)
    if (previousRoot === undefined) delete process.env.MEDIA_ROOT; else process.env.MEDIA_ROOT = previousRoot
    fs.rmSync(root, { recursive: true, force: true })
  }
})


it('same-key concurrent first issue returns one invoice and one audit', async () => {
  const order = await makeConfirmedOrder(channelId, false)
  const input = { storeId, orderId: order.id, actor: user, requestKey: randomUUID(), expectedVersion: 0 }
  const results = await Promise.all(Array.from({ length: 5 }, () => issueInvoice(input, prisma)))
  expect(new Set(results.map(result => result.id)).size).toBe(1)
  expect(results.filter(result => !result.repeated)).toHaveLength(1)
  expect(await prisma.invoice.count({ where: { orderId: order.id } })).toBe(1)
  expect(await prisma.auditEntry.count({ where: { targetId: results[0].id, action: 'InvoiceIssued' } })).toBe(1)
})

it('different concurrent requests against one version have one winner and a controlled conflict', async () => {
  const order = await makeConfirmedOrder()
  const results = await Promise.allSettled(Array.from({ length: 2 }, () => issueInvoice({ storeId, orderId: order.id, actor: user, expectedVersion: 1, requestKey: randomUUID() }, prisma)))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  expect(rejected.reason).toMatchObject({ code: 'VERSION_CONFLICT' })
  expect(await prisma.invoice.count({ where: { orderId: order.id } })).toBe(2)
  expect(await prisma.invoice.count({ where: { orderId: order.id, status: 'ISSUED' } })).toBe(1)
})

it('same reissue request replays after a new client and never reactivates a replaced invoice', async () => {
  const order = await makeConfirmedOrder()
  const input = { storeId, orderId: order.id, actor: user, expectedVersion: 1, requestKey: randomUUID() }
  const v2 = await issueInvoice(input, prisma)
  const fresh = new PrismaClient()
  try { expect(await issueInvoice(input, fresh)).toMatchObject({ id: v2.id, repeated: true }) }
  finally { await fresh.$disconnect() }
  const v3 = await issueInvoice({ ...input, expectedVersion: 2, requestKey: randomUUID() }, prisma)
  expect(await issueInvoice(input, prisma)).toMatchObject({ id: v2.id, status: 'VOID', repeated: true })
  await expect(issueInvoice({ ...input, expectedVersion: 3 }, prisma)).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' })
  expect((await getCurrentInvoice({ storeId, orderId: order.id }, prisma))?.id).toBe(v3.id)
  expect(await prisma.auditEntry.count({ where: { targetId: v2.id, action: 'InvoiceReissued' } })).toBe(1)
})

it('does not implicitly reissue when no expected version is supplied', async () => {
  const order = await makeConfirmedOrder()
  await expect(issueInvoice({ storeId, orderId: order.id, actor: user }, prisma)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  expect(await prisma.invoice.count({ where: { orderId: order.id } })).toBe(1)
})

it('rolls back voiding and the request receipt on a failed write; same request succeeds after recovery', async () => {
  const order = await makeConfirmedOrder(), other = await makeConfirmedOrder()
  const old = (await getCurrentInvoice({ storeId, orderId: order.id }, prisma))!
  const conflict = (await getCurrentInvoice({ storeId, orderId: other.id }, prisma))!
  await prisma.invoice.update({ where: { id: conflict.id }, data: { number: order.number + '-R2' } })
  const input = { storeId, orderId: order.id, actor: user, expectedVersion: 1, requestKey: randomUUID() }
  await expect(issueInvoice(input, prisma)).rejects.toMatchObject({ code: 'NUMBER_CONFLICT' })
  expect(await prisma.invoice.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ status: 'ISSUED', sellerSnapshot: old.sellerSnapshot })
  expect(await prisma.invoice.count({ where: { orderId: order.id } })).toBe(1)
  await prisma.invoice.update({ where: { id: conflict.id }, data: { number: conflict.number } })
  const recovered = await issueInvoice(input, prisma)
  expect(recovered.version).toBe(2)
  expect(await prisma.auditEntry.count({ where: { targetId: recovered.id, action: 'InvoiceReissued' } })).toBe(1)
})

it('new accepted terms ignore identity/bank injected through invoice profile', async () => {
  const channel = await prisma.fulfillmentChannel.findUniqueOrThrow({ where: { id: channelId } })
  try {
    await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { invoiceProfile: { vatEnabled: true, vatRate: 20, companyName: 'Wrong seller', inn: 'wrong', bank: { account: 'wrong' }, directorName: 'Allowed signature' } } })
    const order = await makeConfirmedOrder()
    const invoice = (await getCurrentInvoice({ storeId, orderId: order.id }, prisma))!
    expect(sellerOf(invoice)).toMatchObject({ companyName: seller.companyName, inn: seller.inn, bank: seller.bank, directorName: 'Allowed signature' })
  } finally { await prisma.fulfillmentChannel.update({ where: { id: channelId }, data: { invoiceProfile: channel.invoiceProfile! } }) }
})


it('license denial leaves the existing invoice active and retryable after restoration', async () => {
  const order = await makeConfirmedOrder()
  const old = (await getCurrentInvoice({ storeId, orderId: order.id }, prisma))!
  vi.stubEnv('LICENSE_ENFORCE', '1')
  vi.stubEnv('LICENSE_GRANT_PATH', path.join(os.tmpdir(), 'missing-r26-' + randomUUID() + '.json'))
  resetLicenseCache()
  try {
    await expect(issueInvoice({ storeId, orderId: order.id, actor: user, expectedVersion: 1, requestKey: randomUUID() }, prisma)).rejects.toMatchObject({ status: 'ABSENT' })
    expect((await getCurrentInvoice({ storeId, orderId: order.id }, prisma))?.id).toBe(old.id)
    expect(await prisma.invoice.count({ where: { orderId: order.id } })).toBe(1)
  } finally { vi.unstubAllEnvs(); resetLicenseCache() }
})
