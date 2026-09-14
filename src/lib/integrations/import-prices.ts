import type { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'

const ENTITY = 'product'

export type PriceImportStats = { imported: number; failed: number }

/** Resolve a default variant from a provider externalId via ExternalReference. */
async function resolveVariantId(client: PrismaClient, connectionId: string, externalId: string): Promise<string | null> {
  const ref = await client.externalReference.findUnique({
    where: { connectionId_entityType_externalId: { connectionId, entityType: ENTITY, externalId } },
  })
  if (!ref) return null
  const variant = await client.productVariant.findFirst({ where: { productId: ref.entityId, isDefault: true }, select: { id: true } })
  return variant?.id ?? null
}

async function resolveBookId(client: PrismaClient, storeId: string, bookCode?: string): Promise<string | null> {
  if (bookCode) {
    const book = await client.priceBook.findUnique({ where: { storeId_code: { storeId, code: bookCode } }, select: { id: true } })
    if (book) return book.id
  }
  const fallback = await client.priceBook.findFirst({ where: { storeId, isDefault: true }, select: { id: true } })
  return fallback?.id ?? null
}

/**
 * Import prices into PriceEntry (idempotent upsert). Prices are NOT stored on
 * the product — they belong to a PriceBook and are resolved by context.
 */
export async function importPrices(
  input: { storeId: string; connectionId: string; provider: { pullPrices?: (cursor?: string) => Promise<{ items: unknown[]; nextCursor?: string }> } },
  client: PrismaClient = defaultPrisma,
): Promise<PriceImportStats> {
  const stats: PriceImportStats = { imported: 0, failed: 0 }
  if (!input.provider.pullPrices) return stats

  let cursor: string | undefined
  for (;;) {
    const page = await input.provider.pullPrices(cursor)
    for (const item of page.items) {
      try {
        const raw = (item ?? {}) as Record<string, any>
        const externalId = String(raw.externalId ?? raw.id ?? '')
        const amount = Number(raw.amount)
        if (!externalId || !Number.isFinite(amount)) throw new Error('price payload missing externalId/amount')
        const variantId = await resolveVariantId(client, input.connectionId, externalId)
        const bookId = await resolveBookId(client, input.storeId, typeof raw.bookCode === 'string' ? raw.bookCode : undefined)
        if (!variantId || !bookId) throw new Error(`unresolved ${!variantId ? 'variant' : 'price book'} for ${externalId}`)
        await client.priceEntry.upsert({
          where: { priceBookId_variantId: { priceBookId: bookId, variantId } },
          update: { amount },
          create: { priceBookId: bookId, variantId, amount },
        })
        stats.imported += 1
      } catch (error) {
        stats.failed += 1
        await client.integrationError.create({ data: { storeId: input.storeId, connectionId: input.connectionId, code: 'PRICE_IMPORT_FAILED', message: (error as Error).message } })
      }
    }
    cursor = page.nextCursor
    if (!cursor) break
  }
  return stats
}
