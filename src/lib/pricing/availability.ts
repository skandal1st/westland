import type { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'

type Client = PrismaClient

/**
 * Availability is a PROJECTION per (variant, channel), built from the raw Stock
 * at the channel's warehouse. The storefront reads the projection, so a
 * provider/ERP outage never blocks it — the last projection is served, and
 * `sourceUpdatedAt` lets the UI flag staleness.
 */
export async function projectChannelAvailability(channelId: string, client: Client = defaultPrisma): Promise<number> {
  const channel = await client.fulfillmentChannel.findUnique({ where: { id: channelId }, select: { inventoryLocationId: true } })
  if (!channel) return 0
  const stocks = await client.stock.findMany({ where: { locationId: channel.inventoryLocationId } })
  for (const stock of stocks) {
    await client.availabilityProjection.upsert({
      where: { variantId_fulfillmentChannelId: { variantId: stock.variantId, fulfillmentChannelId: channelId } },
      update: { availableQuantity: stock.available, sourceUpdatedAt: stock.sourceUpdatedAt },
      create: { variantId: stock.variantId, fulfillmentChannelId: channelId, availableQuantity: stock.available, sourceUpdatedAt: stock.sourceUpdatedAt },
    })
  }
  return stocks.length
}

/** Rebuild projections for every channel in the store (called after an import). */
export async function projectStoreAvailability(storeId: string, client: Client = defaultPrisma): Promise<void> {
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
  for (const row of rows) result.set(row.variantId, { available: Number(row.availableQuantity), sourceUpdatedAt: row.sourceUpdatedAt })
  return result
}
