import { prisma } from '@/lib/db'
import { AuditAction, recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/authz'

export class ContentError extends Error {
  constructor(public code: 'NOT_FOUND' | 'SLUG_TAKEN') {
    super(code)
    this.name = 'ContentError'
  }
}

export type ContentPatch = {
  displayName?: string
  slug?: string
  description?: string
  imageUrls?: string[]
  seoTitle?: string | null
  seoDescription?: string | null
  attributes?: unknown
}

/**
 * Update the commerce overlay for a product (STAFF/ADMIN). This is the surface
 * that survives provider sync; edits here are authoritative for the storefront.
 */
export async function updateProductContent(
  productId: string,
  patch: ContentPatch,
  options: { actor: SessionUser | null },
) {
  return prisma.$transaction(async (tx) => {
    const content = await tx.commerceProductContent.findUnique({ where: { productId } })
    if (!content) throw new ContentError('NOT_FOUND')

    if (patch.slug && patch.slug !== content.slug) {
      const clash = await tx.commerceProductContent.findUnique({ where: { storeId_slug: { storeId: content.storeId, slug: patch.slug } } })
      if (clash) throw new ContentError('SLUG_TAKEN')
    }

    const updated = await tx.commerceProductContent.update({
      where: { productId },
      data: {
        displayName: patch.displayName ?? undefined,
        slug: patch.slug ?? undefined,
        description: patch.description ?? undefined,
        imageUrls: patch.imageUrls ?? undefined,
        seoTitle: patch.seoTitle === undefined ? undefined : patch.seoTitle,
        seoDescription: patch.seoDescription === undefined ? undefined : patch.seoDescription,
        attributes: patch.attributes === undefined ? undefined : (patch.attributes as any),
        updatedById: options.actor?.id ?? null,
      },
    })

    await recordAudit(tx, {
      storeId: content.storeId,
      actor: options.actor,
      action: AuditAction.ProductContentUpdated,
      targetType: 'CommerceProductContent',
      targetId: productId,
      summary: `Updated content for ${updated.displayName}`,
    })

    return updated
  })
}
