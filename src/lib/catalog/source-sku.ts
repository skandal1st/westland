import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'

/** Serialize allocation across importers in one store; always before Product locks. */
export async function lockCatalogSkus(tx: Prisma.TransactionClient, storeId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`catalog-skus:${storeId}`}, 0))::text`
}
export function sourceIdentitySku(connectionId: string, externalId: string) {
  return `1c:${createHash('sha256').update(JSON.stringify([connectionId, externalId])).digest('hex')}`
}
/** ONE_C article changes never rename a canonical key. Occupancy never implies identity. */
export function allocateSourceSku(input: { connectionId: string; externalId: string; sourceSku: string; currentSku?: string; occupied: (sku: string) => boolean }) {
  if (input.currentSku !== undefined) return input.currentSku
  if (!input.occupied(input.sourceSku)) return input.sourceSku
  const derived = sourceIdentitySku(input.connectionId, input.externalId)
  if (input.occupied(derived)) throw new Error('source_identity_sku_conflict')
  return derived
}
