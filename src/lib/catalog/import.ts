import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { NORMALIZATION_VERSION, fingerprint, normalizeProductSnapshot } from '@/lib/catalog/normalize'

export class CatalogImportError extends Error {
  constructor(public code: 'SKU_CONFLICT') {
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
 *   STABLE across re-imports and provider swaps.
 * - Upserts the default variant + identifiers.
 * - Ensures a CommerceProductContent overlay exists but NEVER overwrites it —
 *   staff edits win over sync.
 */
export async function applyProductSnapshot(
  input: { storeId: string; connectionId: string; payload: unknown },
  client: PrismaClient = defaultPrisma,
): Promise<ImportResult> {
  const normalized = normalizeProductSnapshot(input.payload)
  const raw = (input.payload ?? {}) as Record<string, any>
  const fp = fingerprint(input.payload)

  return client.$transaction(async (tx) => {
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

    const nextStatus = normalized.archived ? 'ARCHIVED' : 'ACTIVE'

    const ref = await tx.externalReference.findUnique({
      where: { connectionId_entityType_externalId: { connectionId: input.connectionId, entityType: ENTITY, externalId: normalized.externalId } },
    })

    let productId: string
    let productCreated = false
    if (ref) {
      productId = ref.entityId
      await tx.product.update({ where: { id: productId }, data: { canonicalName: normalized.canonicalName, status: nextStatus } })
      await tx.externalReference.update({ where: { id: ref.id }, data: { externalCode: normalized.sku, sourceData: input.payload as Prisma.InputJsonValue } })
    } else {
      const product = await tx.product.create({ data: { storeId: input.storeId, canonicalName: normalized.canonicalName, status: nextStatus } })
      productId = product.id
      productCreated = true
      await tx.externalReference.create({
        data: { connectionId: input.connectionId, entityType: ENTITY, entityId: productId, externalId: normalized.externalId, externalCode: normalized.sku, sourceData: input.payload as Prisma.InputJsonValue },
      })
    }

    const existingVariant = await tx.productVariant.findUnique({ where: { storeId_sku: { storeId: input.storeId, sku: normalized.sku } } })
    if (existingVariant && existingVariant.productId !== productId) throw new CatalogImportError('SKU_CONFLICT')
    const variant = await tx.productVariant.upsert({
      where: { storeId_sku: { storeId: input.storeId, sku: normalized.sku } },
      update: { packaging: normalized.packaging ?? '', unitsPerPack: normalized.unitsPerPack ?? 1, status: nextStatus, productId },
      create: { storeId: input.storeId, productId, sku: normalized.sku, packaging: normalized.packaging ?? '', unitsPerPack: normalized.unitsPerPack ?? 1, isDefault: true, status: nextStatus },
    })

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
  })
}

function slugify(value: string): string {
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
