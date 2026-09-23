import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { prisma as db } from '@/lib/db'
import { assertCapability } from '@/lib/capabilities'
import { executionLease, LEASE_MS } from './lease'
import { recoverExpiredWork } from './recovery'
import { refreshQueuedSyncRuns } from './sync-queue'
import { runDueJobs } from './jobs'
import { runDueOrderExports } from './order-export'
import type { IntegrationConnection } from '@prisma/client'
import type { OperationalProvider } from './provider'

/** One bounded turn, at most one import and one export. Alternate priority in
 * the process loop; a slow import cannot indefinitely starve queued exports. */
export async function runWorkerTick(options: { storeId: string; exportsFirst?: boolean; shouldStop?: () => boolean;
  resolveProvider?: (connection: IntegrationConnection, generationId?: string) => OperationalProvider }, client: PrismaClient = db) {
  assertCapability('commerce-core')
  const id = `integrations:${options.storeId}`, token = randomUUID()
  await client.integrationWorker.upsert({ where: { id }, create: { id, storeId: options.storeId }, update: {} })
  const claimed = await client.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "IntegrationWorker" WHERE id = ${id}
      AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp()) FOR UPDATE SKIP LOCKED`
    if (!rows.length) return false
    await tx.$executeRaw`UPDATE "IntegrationWorker" SET "leaseToken" = ${token},
      "leaseExpiresAt" = clock_timestamp() + ${LEASE_MS} * interval '1 millisecond', "lastStartedAt" = clock_timestamp(), "lastError" = NULL WHERE id = ${id}`
    return true
  })
  if (!claimed) return { busy: true, processed: 0 }
  const execution = executionLease(client, { table: 'IntegrationWorker', id, token })
  const owned = execution.client, started = Date.now()
  let processed = 0
  try {
    await recoverExpiredWork(owned, 100, options.storeId)
    await refreshQueuedSyncRuns(owned, options.storeId)
    for (const kind of options.exportsFirst ? ['exports', 'imports'] : ['imports', 'exports']) {
      if (options.shouldStop?.() || Date.now() - started >= 60_000) break
      // Re-read the grant before each work item, not only at process startup.
      assertCapability('commerce-core')
      try {
        const results = kind === 'imports'
          ? await runDueJobs({ storeId: options.storeId, limit: 1, recover: false, resolveProvider: options.resolveProvider }, owned)
          : await runDueOrderExports({ storeId: options.storeId, limit: 1, recover: false, resolveProvider: options.resolveProvider }, owned)
        processed += results.length
      } catch (error) {
        // Projection may itself lose the outer lease. Keep the work item's cause.
        await refreshQueuedSyncRuns(owned, options.storeId).catch(() => undefined)
        throw error
      }
      await refreshQueuedSyncRuns(owned, options.storeId)
    }
    await owned.integrationWorker.update({ where: { id }, data: { leaseToken: null, leaseExpiresAt: null, lastFinishedAt: new Date() } })
    return { busy: false, processed }
  } catch (error) {
    // A lost owner cannot clear a successor's lease or overwrite its diagnostics.
    try { await owned.integrationWorker.update({ where: { id }, data: { leaseToken: null, leaseExpiresAt: null, lastFinishedAt: new Date(), lastError: error instanceof Error ? error.message : String(error) } }) } catch { /* Preserve the work item's error. */ }
    throw error
  } finally { await execution.stop() }
}
