import type { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { applyProductSnapshot } from '@/lib/catalog/import'
import { fingerprint, normalizeProductSnapshot } from '@/lib/catalog/normalize'
import type { OperationalProvider } from '@/lib/integrations/provider'

const ENTITY = 'product'

export type ImportStats = { pages: number; imported: number; skipped: number; failed: number }

/**
 * Page-based, resumable catalog import.
 *
 * - Reads/writes a SyncCheckpoint per page so a restart (or a retried job)
 *   continues where the previous run stopped — progress is never lost.
 * - Uses the Inbox as an idempotency ledger: an unchanged item (same
 *   fingerprint) is skipped instead of re-applied.
 * - A provider outage (pullProducts throws) propagates so the job is retried;
 *   a single bad item is logged and skipped so one poison item cannot block a
 *   whole page.
 * - Never wraps the whole import in one transaction: each page/item commits so
 *   the checkpoint is durable.
 */
export async function importCatalog(
  input: { storeId: string; connectionId: string; provider: OperationalProvider },
  client: PrismaClient = defaultPrisma,
): Promise<ImportStats> {
  const { storeId, connectionId, provider } = input

  let checkpoint = await client.syncCheckpoint.upsert({
    where: { connectionId_entityType: { connectionId, entityType: ENTITY } },
    update: {},
    create: { connectionId, entityType: ENTITY },
  })

  // A completed checkpoint means the previous full sync finished — start fresh.
  if (checkpoint.completed) {
    checkpoint = await client.syncCheckpoint.update({
      where: { id: checkpoint.id },
      data: { cursor: null, page: 0, processed: 0, completed: false, lastExternalId: null },
    })
  }

  let cursor = checkpoint.cursor ?? undefined
  let page = checkpoint.page
  let processed = checkpoint.processed
  const stats: ImportStats = { pages: 0, imported: 0, skipped: 0, failed: 0 }

  for (;;) {
    const result = await provider.pullProducts(cursor) // provider outage -> throws -> job retried
    let lastExternalId: string | null = checkpoint.lastExternalId

    for (const item of result.items) {
      try {
        const normalized = normalizeProductSnapshot(item)
        const fp = fingerprint(item)
        const existing = await client.inbox.findUnique({
          where: { connectionId_entityType_externalId: { connectionId, entityType: ENTITY, externalId: normalized.externalId } },
        })
        if (existing && existing.fingerprint === fp) {
          stats.skipped += 1
        } else {
          await applyProductSnapshot({ storeId, connectionId, payload: item }, client)
          await client.inbox.upsert({
            where: { connectionId_entityType_externalId: { connectionId, entityType: ENTITY, externalId: normalized.externalId } },
            update: { fingerprint: fp, status: 'PROCESSED' },
            create: { storeId, connectionId, entityType: ENTITY, externalId: normalized.externalId, fingerprint: fp, status: 'PROCESSED' },
          })
          stats.imported += 1
        }
        lastExternalId = normalized.externalId
        processed += 1
      } catch (error) {
        // Partial-page tolerance: log the bad item and keep going.
        stats.failed += 1
        await client.integrationError.create({
          data: { storeId, connectionId, code: 'ITEM_IMPORT_FAILED', message: (error as Error).message, context: safeContext(item) },
        })
      }
    }

    cursor = result.nextCursor
    page += 1
    stats.pages += 1
    checkpoint = await client.syncCheckpoint.update({
      where: { id: checkpoint.id },
      data: { cursor: cursor ?? null, page, processed, lastExternalId, completed: !cursor },
    })
    if (!cursor) break
  }

  return stats
}

function safeContext(item: unknown): { externalId?: string } {
  const raw = (item ?? {}) as Record<string, unknown>
  const externalId = raw.externalId ?? raw.id
  return typeof externalId === 'string' ? { externalId } : {}
}
