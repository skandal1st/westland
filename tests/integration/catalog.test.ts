import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { applyProductSnapshot, CatalogImportError } from '@/lib/catalog/import'
import { updateProductContent } from '@/lib/catalog/content'
import { listCatalog } from '@/lib/catalog/read'

const CODE = 'test-catalog'
const prisma = new PrismaClient()
let storeId: string
let connectionId: string

async function cleanup() {
  const store = await prisma.store.findUnique({ where: { slug: CODE } })
  if (store) {
    await prisma.providerSnapshot.deleteMany({ where: { storeId: store.id } })
    await prisma.store.delete({ where: { id: store.id } })
  }
}

beforeAll(async () => {
  await cleanup()
  const store = await prisma.store.create({ data: { slug: CODE, name: 'Test Catalog' } })
  storeId = store.id
  const connection = await prisma.integrationConnection.create({ data: { storeId, provider: 'CUSTOM', name: 'test' } })
  connectionId = connection.id
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

const snapshot = (over: Record<string, unknown> = {}) => ({
  externalId: 'EXT-1', sku: 'SKU-1', name: 'Импортное имя', packaging: '25 г', unitsPerPack: 40, barcode: '4600000000017', ...over,
})

describe('catalog import / overlay (integration)', () => {
  let productId: string

  it('imports canonical + variant + overlay and records provider evidence', async () => {
    const result = await applyProductSnapshot({ storeId, connectionId, payload: snapshot() }, prisma)
    productId = result.productId
    expect(result.productCreated).toBe(true)
    expect(result.contentCreated).toBe(true)

    const product = await prisma.product.findUnique({ where: { id: productId }, include: { content: true, variants: true } })
    expect(product?.canonicalName).toBe('Импортное имя')
    expect(product?.content?.displayName).toBe('Импортное имя')
    expect(product?.variants[0]?.sku).toBe('SKU-1')

    const snap = await prisma.providerSnapshot.findFirst({ where: { storeId, externalId: 'EXT-1' } })
    expect(snap?.normalizationVersion).toBe('1')
    expect(snap?.sourceFingerprint).toHaveLength(64)

    const identifier = await prisma.productIdentifier.findFirst({ where: { variantId: product!.variants[0].id } })
    expect(identifier?.value).toBe('4600000000017')
  })

  it('keeps the overlay and canonical id stable when re-imported (overlay wins)', async () => {
    await updateProductContent(productId, { displayName: 'Витринное имя', description: 'Ручное описание' }, { actor: null })

    const result = await applyProductSnapshot({ storeId, connectionId, payload: snapshot({ name: 'Новое импортное имя' }) }, prisma)
    // Canonical id is stable across re-import (ExternalReference mapping).
    expect(result.productId).toBe(productId)
    expect(result.productCreated).toBe(false)
    expect(result.contentCreated).toBe(false)

    const product = await prisma.product.findUnique({ where: { id: productId }, include: { content: true } })
    expect(product?.canonicalName).toBe('Новое импортное имя') // canonical updated
    expect(product?.content?.displayName).toBe('Витринное имя') // overlay NOT overwritten
    expect(product?.content?.description).toBe('Ручное описание')

    expect(await prisma.providerSnapshot.count({ where: { storeId, externalId: 'EXT-1' } })).toBe(2)
  })

  it('exposes the product through the read-model with overlay values', async () => {
    const { items, total } = await listCatalog({ storeId })
    expect(total).toBe(1)
    expect(items[0].displayName).toBe('Витринное имя')
    expect(items[0].sku).toBe('SKU-1')
  })

  it('soft-archives on provider deletion and drops it from the storefront', async () => {
    await applyProductSnapshot({ storeId, connectionId, payload: snapshot({ deleted: true }) }, prisma)
    const product = await prisma.product.findUnique({ where: { id: productId }, include: { content: true } })
    expect(product?.status).toBe('ARCHIVED')
    expect(product?.content?.displayName).toBe('Витринное имя') // overlay preserved
    const { total } = await listCatalog({ storeId })
    expect(total).toBe(0)
  })

  it('rejects a SKU already owned by another canonical product', async () => {
    await expect(
      applyProductSnapshot({ storeId, connectionId, payload: snapshot({ externalId: 'EXT-2' }) }, prisma),
    ).rejects.toBeInstanceOf(CatalogImportError)
  })
})
