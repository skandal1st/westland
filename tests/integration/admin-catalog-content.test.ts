import { beforeAll, afterAll, expect, it, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { applyProductSnapshot } from '@/lib/catalog/import'
import { applyProductBatch } from '@/lib/catalog/import-batch'
import { mergeCategories } from '@/lib/catalog/merge-categories'
import { setCategoryBrand } from '@/lib/integrations/onec/manage-brands'
import { openExchangeSession, initializeSession, receiveChunk, finishFile, publishGeneration } from '@/lib/integrations/onec/ledger'
import { scanGroups } from '@/lib/integrations/onec/status'
import { latestGeneration, requireGeneration } from '@/lib/integrations/onec/ledger'
import { GET as brandsGET } from '@/app/api/staff/integrations/onec/brand-groups/route'
import { createOneCProvider } from '@/lib/integrations/onec/provider'
import { saveBannerAsset, readBannerAsset, readImageBody, ASSET_LIMIT, validBannerImage } from '@/lib/content/assets'
import { validateBanner } from '@/lib/content/banner-validation'
import { GET as productsGET } from '@/app/api/staff/products/route'
const db = new PrismaClient(), code = 'test-admin-catalog-content'
let storeId: string, connectionId: string, root: string
vi.mock('@/lib/authz', () => ({ requireApiUser: async () => ({ user: { role: 'ADMIN' } }) }))
vi.mock('@/lib/store', () => ({ getActiveStore: async () => ({ id: storeId }) }))
const oldDir = process.env.ONEC_EXCHANGE_DIR
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-content-')); process.env.ONEC_EXCHANGE_DIR = root
  await db.store.deleteMany({ where: { slug: code } })
  storeId = (await db.store.create({ data: { slug: code, name: code } })).id
  connectionId = (await db.integrationConnection.create({ data: { storeId, name: 'test', provider: 'ONE_C', enabled: true, sourceState: 'ACTIVE', environment: 'TEST' } })).id
})
afterAll(async () => { await db.providerSnapshot.deleteMany({ where: { storeId } }); await db.inbox.deleteMany({ where: { storeId } }); await db.store.delete({ where: { id: storeId } }); await db.$disconnect(); if (oldDir === undefined) delete process.env.ONEC_EXCHANGE_DIR; else process.env.ONEC_EXCHANGE_DIR = oldDir })
it('lists every page, searches past the first 50, includes archived products and rejects malformed pagination', async () => {
  await db.product.createMany({ data: Array.from({ length: 65 }, (_, i) => ({ storeId, canonicalName: 'Pagination ' + i, status: i === 64 ? 'ARCHIVED' : 'ACTIVE' })) })
  const first = await (await productsGET(new Request('http://test/api?take=50'))).json()
  const next = await (await productsGET(new Request('http://test/api?take=50&skip=50'))).json()
  expect(first.total).toBe(65); expect(first.products).toHaveLength(50); expect(next.products).toHaveLength(15)
  expect(new Set([...first.products, ...next.products].map(p => p.id)).size).toBe(65)
  const found = await (await productsGET(new Request('http://test/api?q=Pagination%2064'))).json()
  expect(found.products[0].status).toBe('ARCHIVED')
  expect((await productsGET(new Request('http://test/api?skip=NaN'))).status).toBe(400)
})
it('merges provider categories permanently, maintains hierarchy and retargets gift rules without crossing stores', async () => {
  const product = await applyProductSnapshot({ storeId, connectionId, payload: { externalId: 'merge', sku: 'merge', name: 'Merged', categoryExternalId: 'category-a', categoryName: 'A' } }, db)
  const category = await db.category.findFirstOrThrow({ where: { storeId, name: 'A' } })
  const intermediate = await db.category.create({ data: { storeId, name: 'Middle', slug: 'middle', parentId: category.id } })
  const target = await db.category.create({ data: { storeId, name: 'Target', slug: 'target', parentId: intermediate.id } })
  await db.externalReference.create({ data: { connectionId, entityType: 'category', entityId: target.id, externalId: 'category-target' } })
  const promotion = await db.giftPromotion.create({ data: { storeId, name: 'Merge gift', rule: { condition: { categoryId: category.id }, reward: { categoryId: category.id }, minQty: 5, rewardQty: 1 } } })
  await expect(mergeCategories(storeId, 'foreign', [category.id])).rejects.toThrow('category_not_found')
  expect((await mergeCategories(storeId, target.id, [category.id])).productsMoved).toBe(1)
  expect((await db.category.findUniqueOrThrow({ where: { id: target.id } })).parentId).toBeNull()
  await applyProductSnapshot({ storeId, connectionId, payload: { externalId: 'merge', sku: 'merge', name: 'Updated', categoryExternalId: 'category-a', categoryName: 'A' } }, db)
  expect((await db.product.findUniqueOrThrow({ where: { id: product.productId } })).categoryId).toBe(target.id)
  expect(await db.category.findUnique({ where: { id: category.id } })).toMatchObject({ hidden: true, mergedIntoId: target.id })
  expect((await db.giftPromotion.findUniqueOrThrow({ where: { id: promotion.id } })).rule).toMatchObject({ condition: { categoryId: target.id }, reward: { categoryId: target.id } })
})
it('maps nested categories immediately and respects current marks on single and batch re-imports', async () => {
  const xml = '<КоммерческаяИнформация><Классификатор><Группы><Группа><Ид>top</Ид><Наименование>Каталог</Наименование><Группы><Группа><Ид>brand</Ид><Наименование>Бренд</Наименование><Группы><Группа><Ид>leaf</Ид><Наименование>Линейка</Наименование></Группа></Группы></Группа></Группы></Группа></Группы></Классификатор><Каталог><Товары><Товар><Ид>brand-product</Ид><Артикул>B1</Артикул><Наименование>Товар бренда</Наименование><Группы><Ид>leaf</Ид></Группы></Товар></Товары></Каталог></КоммерческаяИнформация>'
  const credentials = [{ connectionId, user: 'onec', pass: 'test-password' }]
  const session = await openExchangeSession(storeId, credentials[0], 'test-secret', db)
  const authority = { storeId, sessionId: session.id, credentials, secret: 'test-secret' }
  await initializeSession(authority, db); await receiveChunk(authority, 'import.xml', Buffer.from(xml), db); await finishFile(authority, 'import.xml', db)
  const actor = await db.user.create({ data: { storeId, email: 'admin@fixture.test', name: 'Admin', role: 'ADMIN', passwordHash: 'fixture' } })
  const generation = await publishGeneration(storeId, connectionId, [session.id], actor, db)
  const page = await createOneCProvider(connectionId, generation.id).pullProducts()
  const payload = page.items[0]
  const imported = await applyProductSnapshot({ storeId, connectionId, payload }, db)
  // Production regression: settings/credentials rotated after the full catalog was imported.
  await db.integrationConnection.update({ where: { id: connectionId }, data: { exchangeRevision: { increment: 1 } } })
  expect(await latestGeneration(connectionId, db)).toBeNull()
  await expect(requireGeneration(connectionId, generation.id, db)).rejects.toThrow('generation_source_changed')
  expect((await scanGroups(connectionId)).map(g => g.externalId)).toEqual(['top', 'brand', 'leaf'])
  // A later prices-only publication must not replace the displayed category tree either.
  const priceSession = await openExchangeSession(storeId, credentials[0], 'test-secret', db)
  const priceAuthority = { ...authority, sessionId: priceSession.id }
  await initializeSession(priceAuthority, db)
  await receiveChunk(priceAuthority, 'offers.xml', Buffer.from('<КоммерческаяИнформация><ПакетПредложений><Предложения/></ПакетПредложений></КоммерческаяИнформация>'), db)
  await finishFile(priceAuthority, 'offers.xml', db)
  await publishGeneration(storeId, connectionId, [priceSession.id], actor, db)
  const response = await (await brandsGET()).json()
  expect(response.hasConnection).toBe(true)
  expect(response.groups).toHaveLength(3)
  expect(response.groups.find((g: { externalId: string }) => g.externalId === 'leaf').path).toEqual(['Каталог', 'Бренд', 'Линейка'])

  await setCategoryBrand(storeId, connectionId, 'brand', true)
  let p = await db.product.findUniqueOrThrow({ where: { id: imported.productId }, include: { brand: true } })
  expect(p.brand?.name).toBe('Бренд')
  await setCategoryBrand(storeId, connectionId, 'leaf', true)
  p = await db.product.findUniqueOrThrow({ where: { id: imported.productId }, include: { brand: true } }); expect(p.brand?.name).toBe('Линейка')
  await setCategoryBrand(storeId, connectionId, 'leaf', false)
  await applyProductSnapshot({ storeId, connectionId, payload }, db)
  p = await db.product.findUniqueOrThrow({ where: { id: imported.productId }, include: { brand: true } }); expect(p.brand?.name).toBe('Бренд')
  await setCategoryBrand(storeId, connectionId, 'brand', false)
  await db.$transaction(tx => applyProductBatch({ storeId, connectionId, payloads: [payload] }, tx))
  expect((await db.product.findUniqueOrThrow({ where: { id: imported.productId } })).brandId).toBeNull()
  await expect(setCategoryBrand(storeId, connectionId, 'unknown', true)).rejects.toThrow('group_not_found')
})
it('decodes uploads into durable webp, bounds request streams, rejects active SVG and store-crossing banner links', async () => {
  const bytes = await sharp({ create: { width: 60, height: 20, channels: 3, background: '#7800f0' } }).png().toBuffer()
  const url = await saveBannerAsset(storeId, bytes)
  const saved = await readBannerAsset(storeId, url.split('/').pop()!)
  expect((await sharp(saved!).metadata()).format).toBe('webp')
  expect(await fs.stat(path.join(root, 'content-assets', storeId, url.split('/').pop()!))).toBeTruthy()
  expect(await readBannerAsset('another-store', url.split('/').pop()!)).toBeNull()
  expect(await readBannerAsset(storeId, '../../secret')).toBeNull()
  await expect(saveBannerAsset(storeId, Buffer.from('<svg><script>alert(1)</script></svg>'))).rejects.toThrow('invalid_image')
  await expect(readImageBody(new Request('http://test', { method: 'POST', body: new Uint8Array(ASSET_LIMIT + 1) }))).rejects.toThrow('image_too_large')
  expect(validBannerImage('javascript:alert(1)')).toBe(false)
  expect(await validateBanner(storeId, { isActive: true, desktopImageUrl: url })).toBeNull()
  expect(await validateBanner(storeId, { brandId: 'another-store-brand' })).toBe('invalid_relation')
  expect(await validateBanner(storeId, { isActive: true })).toBe('image_required')
  expect(await validateBanner(storeId, { startsAt: new Date('2030-01-02'), endsAt: new Date('2030-01-01') })).toBe('invalid_dates')
})
