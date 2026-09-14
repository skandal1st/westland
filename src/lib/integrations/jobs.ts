import type { IntegrationConnection, IntegrationJob, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { importCatalog } from '@/lib/integrations/import-catalog'
import { importPrices } from '@/lib/integrations/import-prices'
import { importAvailability } from '@/lib/integrations/import-availability'
import { getProvider } from '@/lib/integrations/registry'
import type { OperationalProvider } from '@/lib/integrations/provider'

export const JOB_CATALOG_IMPORT = 'catalog.import'
export const JOB_PRICES_IMPORT = 'prices.import'
export const JOB_AVAILABILITY_IMPORT = 'availability.import'
const BASE_BACKOFF_MS = 1_000

type HandlerDeps = { prisma: PrismaClient; job: IntegrationJob; provider: OperationalProvider }
type Handler = (deps: HandlerDeps) => Promise<Record<string, unknown>>

const handlers: Record<string, Handler> = {
  [JOB_CATALOG_IMPORT]: async ({ prisma, job, provider }) => {
    return importCatalog({ storeId: job.storeId, connectionId: job.connectionId, provider }, prisma) as Promise<Record<string, unknown>>
  },
  [JOB_PRICES_IMPORT]: async ({ prisma, job, provider }) => {
    return importPrices({ storeId: job.storeId, connectionId: job.connectionId, provider }, prisma) as Promise<Record<string, unknown>>
  },
  [JOB_AVAILABILITY_IMPORT]: async ({ prisma, job, provider }) => {
    return importAvailability({ storeId: job.storeId, connectionId: job.connectionId, provider }, prisma) as Promise<Record<string, unknown>>
  },
}

export type RunResult = { jobId: string; status: 'succeeded' | 'retrying' | 'failed'; message?: string; stats?: Record<string, unknown> }

/** Idempotent enqueue: an active job for (connection, type) is reused, not duplicated. */
export async function enqueueJob(
  input: { storeId: string; connectionId: string; type: string; payload?: unknown; maxAttempts?: number },
  client: PrismaClient = defaultPrisma,
): Promise<IntegrationJob> {
  const active = await client.integrationJob.findFirst({
    where: { connectionId: input.connectionId, type: input.type, status: { in: ['PENDING', 'RUNNING', 'RETRYING'] } },
  })
  if (active) return active
  return client.integrationJob.create({
    data: {
      storeId: input.storeId,
      connectionId: input.connectionId,
      type: input.type,
      idempotencyKey: `${input.type}:${input.connectionId}:${Date.now()}`,
      payload: (input.payload ?? undefined) as any,
      maxAttempts: input.maxAttempts ?? 5,
      // Set from the app clock so due-detection is consistent with runDueJobs
      // (avoids DB/app clock skew leaving a fresh job briefly "not due").
      availableAt: new Date(),
    },
  })
}

/** Run one attempt of a job with durable attempt/error tracking and bounded retry. */
export async function runJob(job: IntegrationJob, deps: { provider: OperationalProvider }, client: PrismaClient = defaultPrisma): Promise<RunResult> {
  const attempt = job.attempts + 1
  const attemptRow = await client.integrationAttempt.create({ data: { jobId: job.id, attempt, status: 'RUNNING' } })
  await client.integrationJob.update({ where: { id: job.id }, data: { status: 'RUNNING', attempts: attempt, startedAt: job.startedAt ?? new Date() } })

  const handler = handlers[job.type]
  try {
    if (!handler) throw new Error(`No handler registered for job type "${job.type}"`)
    const stats = await handler({ prisma: client, job, provider: deps.provider })
    await client.integrationJob.update({ where: { id: job.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), lastError: null } })
    await client.integrationAttempt.update({ where: { id: attemptRow.id }, data: { status: 'SUCCEEDED', stats: stats as any, finishedAt: new Date() } })
    return { jobId: job.id, status: 'succeeded', stats }
  } catch (error) {
    const message = (error as Error).message
    await client.integrationError.create({ data: { storeId: job.storeId, connectionId: job.connectionId, jobId: job.id, code: 'JOB_FAILED', message } })
    await client.integrationAttempt.update({ where: { id: attemptRow.id }, data: { status: 'FAILED', error: message, finishedAt: new Date() } })
    if (attempt >= job.maxAttempts) {
      await client.integrationJob.update({ where: { id: job.id }, data: { status: 'FAILED', finishedAt: new Date(), lastError: message } })
      return { jobId: job.id, status: 'failed', message }
    }
    const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1)
    await client.integrationJob.update({ where: { id: job.id }, data: { status: 'RETRYING', availableAt: new Date(Date.now() + backoff), lastError: message } })
    return { jobId: job.id, status: 'retrying', message }
  }
}

/** Process due jobs (PENDING/RETRYING with availableAt <= now). In-process; no broker. */
export async function runDueJobs(
  options: { now?: Date; limit?: number; resolveProvider?: (connection: IntegrationConnection) => OperationalProvider } = {},
  client: PrismaClient = defaultPrisma,
): Promise<RunResult[]> {
  const now = options.now ?? new Date()
  const resolve = options.resolveProvider ?? ((connection) => getProvider(connection))
  const jobs = await client.integrationJob.findMany({
    where: { status: { in: ['PENDING', 'RETRYING'] }, availableAt: { lte: now } },
    orderBy: { availableAt: 'asc' },
    take: options.limit ?? 10,
    include: { connection: true },
  })
  const results: RunResult[] = []
  for (const job of jobs) {
    results.push(await runJob(job, { provider: resolve(job.connection) }, client))
  }
  return results
}
