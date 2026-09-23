import type { PrismaClient, Prisma } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'

type Client = PrismaClient | Prisma.TransactionClient

/**
 * Availability is a PROJECTION per (variant, channel), built from the raw Stock
 * at the channel's warehouse, clamped to zero for sale. Raw signed Stock is
 * preserved; other warehouses never compensate it. The storefront reads the projection, so a
 * provider/ERP outage never blocks it — the last projection is served, and
 * `sourceUpdatedAt` lets the UI flag staleness.
 */
export async function projectChannelAvailability(channelId: string, client: Client = defaultPrisma): Promise<number> {
  if ('$transaction' in client) return client.$transaction(tx => projectChannelAvailability(channelId, tx), { timeout: 120_000 })
  const count = await client.$executeRaw`INSERT INTO "AvailabilityProjection"
    (id, "variantId", "fulfillmentChannelId", "availableQuantity", "sourceUpdatedAt", "updatedAt")
    SELECT gen_random_uuid()::text, s."variantId", c.id, GREATEST(s.available, 0), s."sourceUpdatedAt", CURRENT_TIMESTAMP
    FROM "FulfillmentChannel" c JOIN "Stock" s ON s."locationId" = c."inventoryLocationId" WHERE c.id = ${channelId}
    ON CONFLICT ("variantId", "fulfillmentChannelId") DO UPDATE SET "availableQuantity" = EXCLUDED."availableQuantity",
      "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt", "updatedAt" = CURRENT_TIMESTAMP`
  // Bulk inserts are visible before PostgreSQL refreshes table statistics. Keep this
  // correlated tuple probe (OFFSET 0 prevents anti-join flattening): otherwise an
  // underestimated nested loop may scan the whole warehouse for every projection.
  await client.$executeRaw`DELETE FROM "AvailabilityProjection" a WHERE a."fulfillmentChannelId" = ${channelId}
    AND NOT EXISTS (SELECT 1 FROM "Stock" s WHERE s."variantId" = a."variantId"
      AND s."locationId" = (SELECT c."inventoryLocationId" FROM "FulfillmentChannel" c WHERE c.id = ${channelId}) OFFSET 0)`
  return count
}

/** Rebuild projections for every channel in the store (called after an import). */
export async function projectStoreAvailability(storeId: string, client: Client = defaultPrisma): Promise<void> {
  if ('$transaction' in client) return client.$transaction(tx => projectStoreAvailability(storeId, tx), { timeout: 120_000 })
  const channels = await client.fulfillmentChannel.findMany({ where: { storeId }, select: { id: true } })
  for (const channel of channels) await projectChannelAvailability(channel.id, client)
}

export type ResolvedAvailability = { available: number; sourceUpdatedAt: Date | null }

export async function availabilityForVariants(
  input: { variantIds: string[]; channelId: string },
  client: Client = defaultPrisma,
): Promise<Map<string, ResolvedAvailability>> {
  const result = new Map<string, ResolvedAvailability>()
  if (input.variantIds.length === 0) return result
  const rows = await client.availabilityProjection.findMany({
    where: { fulfillmentChannelId: input.channelId, variantId: { in: input.variantIds } },
  })
  for (const row of rows) result.set(row.variantId, { available: Math.max(0, Number(row.availableQuantity)), sourceUpdatedAt: row.sourceUpdatedAt })
  return result
}
