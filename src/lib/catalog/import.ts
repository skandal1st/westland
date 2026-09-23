import { categoryPathResolver } from './category-path'
import { rememberGroupPaths } from './group-mapping'
import { mappedBrand } from './brand-mapping'
import type { Prisma, PrismaClient, ProductStatus } from '@prisma/client'
import { allocateSourceSku, lockCatalogSkus, sourceIdentitySku } from './source-sku'
import { prisma as defaultPrisma } from '@/lib/db'
import { NORMALIZATION_VERSION, fingerprint, normalizeProductSnapshot } from '@/lib/catalog/normalize'

export class CatalogImportError extends Error {
  constructor(public code: 'SKU_CONFLICT' | 'VARIANT_IDENTITY_AMBIGUOUS') {
    super(code)
    this.name = 'CatalogImportError'
  }
}

const ENTITY = 'product'

export type ImportResult = {
  productId: string
  variantId: string
  productCreated: boolean
  contentCreated: boolean
  archived: boolean
}

/**
 * Apply one provider product snapshot to the canonical catalog.
 *
 * - Records the raw snapshot with provider evidence (fingerprint / version /
 *   receivedAt / normalizationVersion).
 * - Resolves the canonical Product via ExternalReference so the canonical id is
 *   STABLE across re-imports of the same source identity.
 * - Upserts the default variant + identifiers.
 * - Ensures a CommerceProductContent overlay exists but NEVER overwrites it —
 *   staff edits win over sync.
 */
export async function applyProductSnapshot(
  input: { storeId: string; connectionId: string; payload: unknown },
  client: PrismaClient = defaultPrisma,
): Promise<ImportResult> {
  return client.$transaction(tx => applyProductSnapshotInTransaction(input, tx)).catch((error: unknown) => {
    // A concurrent import of a different product may acquire this SKU after
    // our ownership lookup. PostgreSQL still rejects it; expose the same code.
    const prismaError = error as { code?: string; meta?: { target?: string[] } }
    if (prismaError.code === 'P2002' && Array.isArray(prismaError.meta?.target) && prismaError.meta.target.includes('sku')) {
      throw new CatalogImportError('SKU_CONFLICT')
    }
    throw error
  })
}

export async function applyProductSnapshotInTransaction(input: { storeId: string; connectionId: string; payload: unknown }, tx: Prisma.TransactionClient): Promise<ImportResult> {
  const normalized = normalizeProductSnapshot(input.payload)
  const raw = (input.payload ?? {}) as Record<string, any>
  const fp = fingerprint(input.payload)
  // Same lock order as the atomic source importer: connection, SKU namespace, Product.
  await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${input.connectionId} FOR UPDATE`
  const source = await tx.integrationConnection.findUniqueOrThrow({ where: { id: input.connectionId } })
  if (source.storeId !== input.storeId) throw new Error('product_source_conflict')
  await lockCatalogSkus(tx, input.storeId)
  if (source.provider === 'ONE_C') source.config = await rememberGroupPaths(tx, input.connectionId, source.config, [raw])


  await tx.providerSnapshot.create({
    data: {
      storeId: input.storeId,
      connectionId: input.connectionId,
      entityType: ENTITY,
      externalId: normalized.externalId,
      sourceFingerprint: fp,
      providerVersion: typeof raw.providerVersion === 'string' ? raw.providerVersion : null,
      sourceUpdatedAt: normalized.sourceUpdatedAt ?? null,
      normalizationVersion: NORMALIZATION_VERSION,
      payload: input.payload as Prisma.InputJsonValue,
    },
  })

  const nextStatus: ProductStatus = normalized.archived ? 'ARCHIVED' : 'ACTIVE'

  // Resolve/create the category from the provider group (idempotent via
  // ExternalReference); staff can rename it later without a re-import breaking.
  const categoryId = source.provider === 'ONE_C'
    ? await categoryPathResolver(tx, input.storeId, input.connectionId, source.config)(raw)
    : await resolveCategoryId(tx, input.storeId, input.connectionId, normalized.categoryExternalId, normalized.categoryName)
  // Brand: only set when the provider resolved one (the nearest group staff
  // marked as a brand); otherwise leave the product without a brand.
  const mapped = source.provider === 'ONE_C' ? mappedBrand(raw, source.config) : undefined
  const brandId = mapped === null ? null : await resolveBrandId(tx, input.storeId, input.connectionId, mapped?.id ?? normalized.brandExternalId, mapped?.name ?? normalized.brandName)

  const ref = await tx.externalReference.findUnique({
    where: { connectionId_entityType_externalId: { connectionId: input.connectionId, entityType: ENTITY, externalId: normalized.externalId } },
  })

  if (ref) {
    const owner = await tx.product.findFirst({ where: { id: ref.entityId, storeId: input.storeId } })
    const other = await tx.externalReference.findFirst({ where: { entityType: ENTITY, entityId: ref.entityId, OR: [{ connectionId: { not: input.connectionId } }, { externalId: { not: normalized.externalId } }] } })
    if (!owner || other) throw new Error('product_source_conflict')
  }
  let productId: string
  let productCreated = false
  if (ref) {
    productId = ref.entityId
    await tx.product.update({ where: { id: productId }, data: { canonicalName: normalized.canonicalName, status: nextStatus, ...(categoryId ? { categoryId } : {}), ...(brandId !== undefined ? { brandId } : {}) } })
    await tx.externalReference.update({ where: { id: ref.id }, data: { externalCode: normalized.sku, sourceData: input.payload as Prisma.InputJsonValue } })
  } else {
    const product = await tx.product.create({ data: { storeId: input.storeId, canonicalName: normalized.canonicalName, status: nextStatus, ...(categoryId ? { categoryId } : {}), ...(brandId !== undefined ? { brandId } : {}) } })
    productId = product.id
    productCreated = true
    await tx.externalReference.create({
      data: { connectionId: input.connectionId, entityType: ENTITY, entityId: productId, externalId: normalized.externalId, externalCode: normalized.sku, sourceData: input.payload as Prisma.InputJsonValue },
    })
  }

  // SKU is mutable business data, never the identity of an existing variant.
  // The product update above locks an existing product until this transaction
  // commits, serializing concurrent changes to its default variant.
  const defaults = await tx.productVariant.findMany({ where: { productId, isDefault: true }, take: 2 })
  if (defaults.length > 1) throw new CatalogImportError('VARIANT_IDENTITY_AMBIGUOUS')
  const current = defaults[0]
  const skuOwner = await tx.productVariant.findUnique({ where: { storeId_sku: { storeId: input.storeId, sku: normalized.sku } } })
  if (source.provider !== 'ONE_C' && skuOwner && skuOwner.id !== current?.id) throw new CatalogImportError('SKU_CONFLICT')
  if (!current && await tx.productVariant.count({ where: { productId } })) throw new CatalogImportError('VARIANT_IDENTITY_AMBIGUOUS')
  let sku = normalized.sku
  if (source.provider === 'ONE_C') {
    const derived = !current && skuOwner ? await tx.productVariant.findUnique({ where: { storeId_sku: { storeId: input.storeId, sku: sourceIdentitySku(input.connectionId, normalized.externalId) } } }) : null
    sku = allocateSourceSku({ connectionId: input.connectionId, externalId: normalized.externalId, sourceSku: normalized.sku, currentSku: current?.sku, occupied: value => value === normalized.sku ? Boolean(skuOwner) : Boolean(derived) })
  }
  const data = { sku, ...(source.provider === 'ONE_C' ? { sourceSku: normalized.sku } : {}), packaging: normalized.packaging ?? '', unitsPerPack: normalized.unitsPerPack ?? 1, status: nextStatus }
  const variant = current
    ? await tx.productVariant.update({ where: { id: current.id }, data })
    : await tx.productVariant.create({ data: { ...data, storeId: input.storeId, productId, isDefault: true } })

  // Re-sync identifiers for this variant.
  await tx.productIdentifier.deleteMany({ where: { variantId: variant.id } })
  if (normalized.identifiers.length > 0) {
    await tx.productIdentifier.createMany({
      data: normalized.identifiers.map((i) => ({ variantId: variant.id, type: i.type, value: i.value })),
      skipDuplicates: true,
    })
  }

  // Overlay: create on first import, never overwrite afterwards.
  const existingContent = await tx.commerceProductContent.findUnique({ where: { productId } })
  let contentCreated = false
  if (!existingContent) {
    const slug = await uniqueSlug(tx, input.storeId, normalized.canonicalName, normalized.sku)
    await tx.commerceProductContent.create({
      data: { storeId: input.storeId, productId, displayName: normalized.canonicalName, slug, imageUrls: [] },
    })
    contentCreated = true
  }

  return { productId, variantId: variant.id, productCreated, contentCreated, archived: normalized.archived }

}


const CATEGORY = 'category'
const BRAND = 'brand'

/** Resolve/create the Brand for a marked provider group (idempotent via ExternalReference). */
export async function resolveBrandId(
  tx: Prisma.TransactionClient,
  storeId: string,
  connectionId: string,
  externalId?: string,
  name?: string,
): Promise<string | undefined> {
  if (!externalId) return undefined
  const ref = await tx.externalReference.findUnique({
    where: { connectionId_entityType_externalId: { connectionId, entityType: BRAND, externalId } },
  })
  if (ref) return ref.entityId
  const label = name || externalId
  const slug = await uniqueBrandSlug(tx, storeId, label)
  const brand = await tx.brand.create({ data: { storeId, name: label, slug } })
  await tx.externalReference.create({ data: { connectionId, entityType: BRAND, entityId: brand.id, externalId } })
  return brand.id
}

async function uniqueBrandSlug(tx: Prisma.TransactionClient, storeId: string, name: string): Promise<string> {
  const base = slugify(name) || 'brand'
  const candidates = [base, `${base}-${slugify(String(Date.now().toString(36)))}`]
  for (const candidate of candidates) {
    const taken = await tx.brand.findUnique({ where: { storeId_slug: { storeId, slug: candidate } } })
    if (!taken) return candidate
  }
  return `${base}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Resolve the canonical Category id for a provider group, creating it on first
 * sight. The mapping is kept in ExternalReference (entityType 'category') so the
 * canonical id is stable across re-imports and staff renames are preserved.
 */
export async function resolveCategoryId(
  tx: Prisma.TransactionClient,
  storeId: string,
  connectionId: string,
  externalId?: string,
  name?: string,
): Promise<string | undefined> {
  if (!externalId) return undefined
  const ref = await tx.externalReference.findUnique({
    where: { connectionId_entityType_externalId: { connectionId, entityType: CATEGORY, externalId } },
  })
  if (ref) {
    const category = await tx.category.findFirstOrThrow({ where: { id: ref.entityId, storeId }, select: { id: true, mergedIntoId: true } })
    if (!category.mergedIntoId) return category.id
    const target = await tx.category.findFirstOrThrow({ where: { id: category.mergedIntoId, storeId, mergedIntoId: null }, select: { id: true } })
    return target.id
  }
  const label = name || externalId
  const slug = await uniqueCategorySlug(tx, storeId, label)
  const category = await tx.category.create({ data: { storeId, name: label, slug } })
  await tx.externalReference.create({ data: { connectionId, entityType: CATEGORY, entityId: category.id, externalId } })
  return category.id
}

async function uniqueCategorySlug(tx: Prisma.TransactionClient, storeId: string, name: string): Promise<string> {
  const base = slugify(name) || 'category'
  const candidates = [base, `${base}-${slugify(String(Date.now().toString(36)))}`]
  for (const candidate of candidates) {
    const taken = await tx.category.findUnique({ where: { storeId_slug: { storeId, slug: candidate } } })
    if (!taken) return candidate
  }
  return `${base}-${Math.random().toString(36).slice(2, 8)}`
}

export function slugify(value: string): string {
  // Latin + digits + Cyrillic; anything else becomes a separator. (No /u flag:
  // the project targets es5.)
  return value.toLowerCase().replace(/[^a-z0-9Ѐ-ӿ]+/g, '-').replace(/^-+|-+$/g, '')
}

async function uniqueSlug(tx: Prisma.TransactionClient, storeId: string, name: string, sku: string): Promise<string> {
  const base = slugify(name) || slugify(sku) || 'product'
  const candidates = [base, `${base}-${slugify(sku)}`, `${base}-${Date.now().toString(36)}`]
  for (const candidate of candidates) {
    const taken = await tx.commerceProductContent.findUnique({ where: { storeId_slug: { storeId, slug: candidate } } })
    if (!taken) return candidate
  }
  return `${base}-${Math.random().toString(36).slice(2, 8)}`
}
