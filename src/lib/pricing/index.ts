import type { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'

type Client = PrismaClient

/**
 * Price is a function of context — never a single Product.price. The applicable
 * PriceBook is resolved channel -> group -> store default; a PriceEntry for the
 * variant (valid at `date`) yields the amount. No entry => not priced => not
 * buyable.
 */
export async function resolveBuyerPriceGroupId(
  buyer: { customerId: string | null; priceGroupId: string | null },
  client: Client = defaultPrisma,
): Promise<string | null> {
  if (buyer.customerId) {
    const assignment = await client.buyerPriceAssignment.findUnique({ where: { customerId: buyer.customerId } })
    if (assignment) return assignment.priceGroupId
  }
  return buyer.priceGroupId ?? null // compatibility fallback
}

export async function resolvePriceBookId(
  input: { storeId: string; groupId?: string | null; channelId?: string | null },
  client: Client = defaultPrisma,
): Promise<string | null> {
  if (input.channelId) {
    const channel = await client.fulfillmentChannel.findUnique({ where: { id: input.channelId }, select: { priceBookId: true } })
    if (channel?.priceBookId) return channel.priceBookId
  }
  if (input.groupId) {
    const group = await client.priceGroup.findUnique({ where: { id: input.groupId }, select: { priceBookId: true } })
    if (group?.priceBookId) return group.priceBookId
  }
  const fallback = await client.priceBook.findFirst({ where: { storeId: input.storeId, isDefault: true }, select: { id: true } })
  return fallback?.id ?? null
}

function withinWindow(entry: { effectiveFrom: Date | null; effectiveTo: Date | null }, date: Date): boolean {
  if (entry.effectiveFrom && entry.effectiveFrom > date) return false
  if (entry.effectiveTo && entry.effectiveTo <= date) return false
  return true
}

export type ResolvedPrice = { amount: number; currency: string }

export async function resolveVariantPrice(
  input: { storeId: string; variantId: string; groupId?: string | null; channelId?: string | null; date?: Date },
  client: Client = defaultPrisma,
): Promise<ResolvedPrice | null> {
  const bookId = await resolvePriceBookId(input, client)
  if (!bookId) return null
  const entry = await client.priceEntry.findUnique({
    where: { priceBookId_variantId: { priceBookId: bookId, variantId: input.variantId } },
    include: { priceBook: { select: { currency: true } } },
  })
  if (!entry || !withinWindow(entry, input.date ?? new Date())) return null
  return { amount: Number(entry.amount), currency: entry.priceBook.currency }
}

/** Batch price lookup for a listing — resolves the book once, then one query. */
export async function priceVariantsInContext(
  input: { storeId: string; variantIds: string[]; groupId?: string | null; channelId?: string | null; date?: Date },
  client: Client = defaultPrisma,
): Promise<Map<string, ResolvedPrice>> {
  const result = new Map<string, ResolvedPrice>()
  if (input.variantIds.length === 0) return result
  const bookId = await resolvePriceBookId(input, client)
  if (!bookId) return result
  const date = input.date ?? new Date()
  const entries = await client.priceEntry.findMany({
    where: { priceBookId: bookId, variantId: { in: input.variantIds } },
    include: { priceBook: { select: { currency: true } } },
  })
  for (const entry of entries) {
    if (withinWindow(entry, date)) result.set(entry.variantId, { amount: Number(entry.amount), currency: entry.priceBook.currency })
  }
  return result
}
