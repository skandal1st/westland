import { assertCapability } from '@/lib/capabilities'
import { ImportExecutionError } from './import-result'
import { importSourceValues } from './source-import'
import type { OperationalProvider } from './provider'
import type { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { projectStoreAvailability } from '@/lib/pricing/availability'

const ENTITY = 'product'

export type AvailabilityImportStats = { imported: number; failed: number }

async function resolveVariantId(client: PrismaClient, connectionId: string, externalId: string): Promise<string | null> {
  const ref = await client.externalReference.findUnique({
    where: { connectionId_entityType_externalId: { connectionId, entityType: ENTITY, externalId } },
  })
  if (!ref) return null
  const variant = await client.productVariant.findFirst({ where: { productId: ref.entityId, isDefault: true }, select: { id: true } })
  return variant?.id ?? null
}

/**
 * Resolve our InventoryLocation for a provider warehouse code. Providers like 1C
 * key stock by an opaque warehouse id (GUID), so staff map it to a location via
 * ExternalReference (entityType 'location'); a direct code match is the fallback.
 */
async function resolveLocationId(client: PrismaClient, storeId: string, connectionId: string, locationCode: string): Promise<string | null> {
  const ref = await client.externalReference.findUnique({
    where: { connectionId_entityType_externalId: { connectionId, entityType: 'location', externalId: locationCode } },
  })
  if (ref) return ref.entityId
  const location = await client.inventoryLocation.findUnique({ where: { storeId_code: { storeId, code: locationCode } }, select: { id: true } })
  return location?.id ?? null
}

/**
 * Import raw availability into Stock (per location), then rebuild the
 * per-channel AvailabilityProjection the storefront reads. The storefront never
 * calls the provider synchronously.
 */
export async function importAvailability(
  input: { storeId: string; connectionId: string; jobId?: string; provider: { pullAvailability?: (cursor?: string) => Promise<{ items: unknown[]; nextCursor?: string }> } },
  client: PrismaClient = defaultPrisma,
): Promise<AvailabilityImportStats> {
  assertCapability('commerce-core')

  if ((input.provider as OperationalProvider).provider === 'ONE_C') return importSourceValues({ ...input, provider: input.provider as OperationalProvider }, 'availability', client)
  const stats: AvailabilityImportStats = { imported: 0, failed: 0 }
  if (!input.provider.pullAvailability) return stats

  let cursor: string | undefined
  try {
    for (;;) {
      const page = await input.provider.pullAvailability(cursor)
      for (const item of page.items) {
        try {
          const raw = (item ?? {}) as Record<string, any>
          const externalId = String(raw.externalId ?? raw.id ?? '')
          const locationCode = String(raw.locationCode ?? '')
          const available = Number(raw.available)
          if (!externalId || !locationCode || !Number.isFinite(available)) throw new Error('availability payload missing fields')
          const variantId = await resolveVariantId(client, input.connectionId, externalId)
          const locationId = await resolveLocationId(client, input.storeId, input.connectionId, locationCode)
          if (!variantId || !locationId) throw new Error(`unresolved ${!variantId ? 'variant' : 'location'} for ${externalId}`)
          const sourceUpdatedAt = raw.sourceUpdatedAt ? new Date(raw.sourceUpdatedAt) : null
          await client.stock.upsert({
            where: { variantId_locationId: { variantId, locationId } },
            update: { available, sourceUpdatedAt },
            create: { variantId, locationId, available, sourceUpdatedAt },
          })
          stats.imported += 1
        } catch (error) {
          stats.failed += 1
          try {
            await client.integrationError.create({ data: { storeId: input.storeId, connectionId: input.connectionId, jobId: input.jobId, code: 'AVAILABILITY_IMPORT_FAILED', message: (error as Error).message, context: { externalId: String((item as Record<string, unknown> | null)?.externalId ?? '') } } })
          } catch { throw error }
        }
      }
      cursor = page.nextCursor
      if (!cursor) break
    }

    // Rebuild projections from the freshly imported Stock.
    await projectStoreAvailability(input.storeId, client)
  } catch (error) { throw new ImportExecutionError(error, { ...stats }) }
  return stats
}
