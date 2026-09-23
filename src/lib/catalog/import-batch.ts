import { mappedCategory, sourceGroupPath, resolveStoreCategory, rememberGroupPaths } from './group-mapping'
import { mappedBrand } from './brand-mapping'
import { randomUUID } from 'node:crypto'
import { allocateSourceSku, lockCatalogSkus } from './source-sku'
import type { Prisma } from '@prisma/client'
import { CatalogImportError, resolveBrandId, resolveCategoryId, slugify } from './import'
import { normalizeProductSnapshot, fingerprint, NORMALIZATION_VERSION } from './normalize'

const BATCH = 500
/** Called only inside the source import transaction after locking its connection.
 * Product locks serialize with the single-item importer. All batches commit or roll back together.
 */
export async function applyProductBatch(input: { storeId: string; connectionId: string; payloads: unknown[] }, tx: Prisma.TransactionClient) {
  const { storeId, connectionId } = input
  const source = await tx.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
  if (source.storeId !== storeId) throw new Error('product_source_conflict')
  const rows = input.payloads.map(payload => ({ payload: payload as Prisma.InputJsonValue, raw: payload as Record<string, unknown>, normalized: normalizeProductSnapshot(payload), fp: fingerprint(payload) }))
  if (!rows.length) return 0
  if (new Set(rows.map(r => r.normalized.externalId)).size !== rows.length) throw new Error('duplicate_product_identity')
  // Stable selection for free source codes in a new full batch.
  rows.sort((a, b) => a.normalized.externalId < b.normalized.externalId ? -1 : a.normalized.externalId > b.normalized.externalId ? 1 : 0)
  await lockCatalogSkus(tx, storeId)
  if (source.provider === 'ONE_C') source.config = await rememberGroupPaths(tx, connectionId, source.config, rows.map(r=>r.raw))
  await tx.$queryRaw`SELECT p.id FROM "Product" p JOIN "ExternalReference" r ON r."entityId" = p.id
    WHERE r."connectionId" = ${connectionId} AND r."entityType" = 'product' AND p."storeId" = ${storeId}
    ORDER BY p.id FOR UPDATE OF p`
  const refs = await tx.externalReference.findMany({ where: { connectionId, entityType: 'product' } })
  const byExternal = new Map(refs.map(r => [r.externalId, r]))
  const products = await tx.product.findMany({ where: { storeId }, select: { id: true, categoryId: true, brandId: true, variants: { select: { id: true, sku: true, isDefault: true } } } })
  const byProduct = new Map(products.map(p => [p.id, p]))
  const owners = new Map(products.flatMap(p => p.variants.map(v => [v.sku, v.id] as const)))
  const foreign = await tx.$queryRaw<Array<{ entityId: string }>>`SELECT DISTINCT r."entityId" FROM "ExternalReference" r
    JOIN "ExternalReference" own ON own."entityId" = r."entityId" AND own."entityType" = 'product'
    WHERE own."connectionId" = ${connectionId} AND r."entityType" = 'product' AND (r."connectionId" <> ${connectionId} OR r."externalId" <> own."externalId")`
  const foreignIds = new Set(foreign.map(r => r.entityId))
  const prepared = rows.map(row => {
    const n = row.normalized, ref = byExternal.get(n.externalId), product = ref ? byProduct.get(ref.entityId) : undefined
    if (ref && (!product || foreignIds.has(ref.entityId))) throw new Error('product_source_conflict')
    const defaults = product?.variants.filter(v => v.isDefault) ?? []
    if (defaults.length > 1 || (!defaults.length && product?.variants.length)) throw new CatalogImportError('VARIANT_IDENTITY_AMBIGUOUS')
    const current = defaults[0], variantId = current?.id ?? randomUUID()
    const sku = allocateSourceSku({ connectionId, externalId: n.externalId, sourceSku: n.sku, currentSku: current?.sku, occupied: value => owners.has(value) })
    owners.set(sku, variantId)
    return { ...row, ref, product, current, productId: product?.id ?? randomUUID(), variantId, sku }
  })
  const existingContent = await tx.commerceProductContent.findMany({ where: { storeId }, select: { productId: true, slug: true } })
  const contentIds = new Set(existingContent.map(c => c.productId)), slugs = new Set(existingContent.map(c => c.slug))
  const categories = new Map<string, string | undefined>(), brands = new Map<string, string | undefined>()
  const writes = []
  for (const row of prepared) {
    const n = row.normalized
    const categoryOverride = source.provider === 'ONE_C' ? mappedCategory(row.raw, source.config) : undefined
    const categoryRoot = source.provider === 'ONE_C' ? sourceGroupPath(row.raw, source.config).at(-1) : undefined
    const categoryExternalId = categoryRoot?.id ?? n.categoryExternalId
    const categoryKey = categoryOverride ? 'site:' + categoryOverride : categoryExternalId ?? ''
    if (!categories.has(categoryKey)) categories.set(categoryKey, categoryOverride ? await resolveStoreCategory(tx, storeId, categoryOverride) : await resolveCategoryId(tx, storeId, connectionId, categoryExternalId, categoryRoot?.name ?? n.categoryName))
    const mapped = source.provider === 'ONE_C' ? mappedBrand(row.raw, source.config) : undefined
    const brandExternalId = mapped === null ? undefined : mapped?.id ?? n.brandExternalId
    const brandName = mapped?.name ?? n.brandName

    if (brandExternalId && !brands.has(brandExternalId)) brands.set(brandExternalId, await resolveBrandId(tx, storeId, connectionId, brandExternalId, brandName))
    let slug: string | undefined
    if (!contentIds.has(row.productId)) {
      const base = slugify(n.canonicalName) || slugify(n.sku) || 'product'
      slug = base
      if (slugs.has(slug)) slug = `${base}-${slugify(n.sku)}`
      while (slugs.has(slug)) slug = `${base}-${randomUUID()}`
      slugs.add(slug)
    }
    writes.push({ ...row, slug, categoryId: categories.get(categoryKey) ?? row.product?.categoryId ?? null,
      brandId: mapped === null ? null : brands.get(brandExternalId ?? '') ?? row.product?.brandId ?? null, status: n.archived ? 'ARCHIVED' as const : 'ACTIVE' as const })
  }
  for (let offset = 0; offset < writes.length; offset += BATCH) {
    const batch = writes.slice(offset, offset + BATCH), created = batch.filter(r => !r.product)
    if (created.length) await tx.product.createMany({ data: created.map(r => ({ id: r.productId, storeId, canonicalName: r.normalized.canonicalName, categoryId: r.categoryId, brandId: r.brandId, status: r.status })) })
    const updates = batch.filter(r => r.product).map(r => ({ id: r.productId, name: r.normalized.canonicalName, category: r.categoryId, brand: r.brandId, status: r.status }))
    if (updates.length) await tx.$executeRaw`UPDATE "Product" p SET "canonicalName" = x.name, "categoryId" = x.category, "brandId" = x.brand,
      status = x.status::"ProductStatus", "updatedAt" = CURRENT_TIMESTAMP FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
      AS x(id text, name text, category text, brand text, status text) WHERE p.id = x.id AND p."storeId" = ${storeId}`
    const newVariants = batch.filter(r => !r.current)
    if (newVariants.length) await tx.productVariant.createMany({ data: newVariants.map(r => ({ id: r.variantId, storeId, productId: r.productId, sku: r.sku, sourceSku: r.normalized.sku, packaging: r.normalized.packaging ?? '', unitsPerPack: r.normalized.unitsPerPack ?? 1, isDefault: true, status: r.status })) })
    const variantUpdates = batch.filter(r => r.current).map(r => ({ id: r.variantId, sku: r.sku, sourceSku: r.normalized.sku, packaging: r.normalized.packaging ?? '', units: r.normalized.unitsPerPack ?? 1, status: r.status }))
    if (variantUpdates.length) await tx.$executeRaw`UPDATE "ProductVariant" v SET sku = x.sku, "sourceSku" = x."sourceSku", packaging = x.packaging, "unitsPerPack" = x.units,
      status = x.status::"ProductStatus", "updatedAt" = CURRENT_TIMESTAMP FROM jsonb_to_recordset(${JSON.stringify(variantUpdates)}::jsonb)
      AS x(id text, sku text, "sourceSku" text, packaging text, units integer, status text) WHERE v.id = x.id AND v."storeId" = ${storeId}`
    const newRefs = batch.filter(r => !r.ref)
    if (newRefs.length) await tx.externalReference.createMany({ data: newRefs.map(r => ({ connectionId, entityType: 'product', entityId: r.productId, externalId: r.normalized.externalId, externalCode: r.normalized.sku, sourceData: r.payload })) })
    const refUpdates = batch.filter(r => r.ref).map(r => ({ id: r.ref!.id, sku: r.normalized.sku, payload: r.payload }))
    if (refUpdates.length) await tx.$executeRaw`UPDATE "ExternalReference" r SET "externalCode" = x.sku, "sourceData" = x.payload, "updatedAt" = CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${JSON.stringify(refUpdates)}::jsonb) AS x(id text, sku text, payload jsonb) WHERE r.id = x.id AND r."connectionId" = ${connectionId}`
    await tx.productIdentifier.deleteMany({ where: { variantId: { in: batch.map(r => r.variantId) } } })
    const identifiers = batch.flatMap(r => r.normalized.identifiers.map(identifier => ({ variantId: r.variantId, ...identifier })))
    if (identifiers.length) await tx.productIdentifier.createMany({ data: identifiers, skipDuplicates: true })
    const content = batch.filter(r => r.slug !== undefined)
    if (content.length) await tx.commerceProductContent.createMany({ data: content.map(r => ({ storeId, productId: r.productId, displayName: r.normalized.canonicalName, slug: r.slug!, imageUrls: [] })) })
    await tx.providerSnapshot.createMany({ data: batch.map(r => ({ storeId, connectionId, entityType: 'product', externalId: r.normalized.externalId, sourceFingerprint: r.fp,
      providerVersion: typeof r.raw.providerVersion === 'string' ? r.raw.providerVersion : null, sourceUpdatedAt: r.normalized.sourceUpdatedAt ?? null, normalizationVersion: NORMALIZATION_VERSION, payload: r.payload })) })
    const inbox = batch.map(r => ({ id: randomUUID(), external: r.normalized.externalId, fingerprint: r.fp }))
    await tx.$executeRaw`INSERT INTO "Inbox" (id, "storeId", "connectionId", "entityType", "externalId", fingerprint, status, "receivedAt")
      SELECT x.id, ${storeId}, ${connectionId}, 'product', x.external, x.fingerprint, 'PROCESSED', CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${JSON.stringify(inbox)}::jsonb) AS x(id text, external text, fingerprint text)
      ON CONFLICT ("connectionId", "entityType", "externalId") DO UPDATE SET fingerprint = EXCLUDED.fingerprint, status = 'PROCESSED'`
  }
  return writes.length
}
