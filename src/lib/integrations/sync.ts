import { assertCapability } from '@/lib/capabilities'
import { randomUUID } from 'node:crypto'
import { executionLease, LEASE_MS } from './lease'
import { recoverExpiredWork } from './recovery'
import type { IntegrationConnection, PrismaClient } from '@prisma/client'
import { prisma as db } from '@/lib/db'
import { enqueueJob, runJob } from './jobs'
import { getProvider } from './registry'
import type { OperationalProvider } from './provider'
import { IMPORT_STAGES, summarizeStages, type SyncReport } from './import-result'

/** Persist every stage, including blocked stages, so reloads never imply full success. */
export async function runSourceSync(connection: IntegrationConnection, generationId?: string, client: PrismaClient = db, resolve = () => getProvider(connection, generationId)): Promise<SyncReport> {
  assertCapability('commerce-core')

  await recoverExpiredWork(client)
  const token = randomUUID()
  const report: SyncReport = { runId: '', generationId: generationId ?? null, outcome: 'running', results: IMPORT_STAGES.map(type => ({ type, status: 'pending' })) }
  const run = await client.$transaction(async tx => {
    const row = await tx.syncRun.create({ data: { connectionId: connection.id, entityType: 'commerce.sync', status: 'RUNNING', startedAt: new Date(), leaseToken: token } })
    await tx.$executeRaw`UPDATE "SyncRun" SET "leaseExpiresAt" = clock_timestamp() + ${LEASE_MS} * interval '1 millisecond' WHERE id = ${row.id}`
    return row
  })
  const execution = executionLease(client, { table: 'SyncRun', id: run.id, token })
  client = execution.client
  try {
    report.runId = run.id
    const persist = async (final = false) => client.syncRun.update({ where: { id: run.id }, data: {
      stats: report as any, status: final ? report.outcome === 'success' ? 'SUCCEEDED' : report.outcome === 'partial' ? 'PARTIAL' : 'FAILED' : 'RUNNING',
      ...(final ? { leaseToken: null, leaseExpiresAt: null, finishedAt: new Date(), error: report.results.find(r => r.outcome === 'failed' || r.outcome === 'partial')?.message } : {}),
    } })
    await persist()
    let stop = false, provider: OperationalProvider | undefined
    for (let index = 0; index < report.results.length; index++) {
      const stage = report.results[index]
      if (stop) { report.results[index] = { ...stage, status: 'skipped', outcome: 'skipped', message: 'previous_stage_incomplete' }; continue }
      try {
        const job = await enqueueJob({ storeId: connection.storeId, connectionId: connection.id, generationId, type: stage.type }, client)
        if (job.status === 'RUNNING') throw new Error('job_running')
        report.results[index] = { ...stage, jobId: job.id, status: 'running' }; await persist()
        const result = await runJob(job, { resolveProvider: () => provider ??= resolve() }, client)
        report.results[index] = result
        stop = result.outcome !== 'success'
      } catch (error) {
        report.results[index] = { ...report.results[index], status: 'failed', outcome: 'failed', message: error instanceof Error ? error.message : String(error) }
        stop = true
      }
      await persist()
    }
    report.outcome = summarizeStages(report.results)
    const error = report.results.find(r => r.outcome !== 'success')?.message
    if (error) report.error = error
    await persist(true)
    return report
  } finally { await execution.stop() }
}
