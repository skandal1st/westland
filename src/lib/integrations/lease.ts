import { Prisma, type PrismaClient } from '@prisma/client'
import type { OperationalProvider } from './provider'
import { IntegrationInputError } from './errors'
import { persistJobFailure, type JobFailure } from './job-failure'

// Keep the transport private: only diagnostic failure completion may bypass
// nested worker/coordinator leases, never provider or business operations.
const transports = new WeakMap<PrismaClient, PrismaClient>()

export const LEASE_MS = 60_000
const EXECUTION_MS = 15 * 60_000
export type Lease = { table: 'IntegrationJob' | 'OrderExport' | 'SyncRun' | 'IntegrationWorker'; id: string; token: string }
export class LeaseLostError extends IntegrationInputError {
  constructor() { super('execution_lease_lost', 409) }
}

/** Every business transaction locks and verifies the owner before touching data.
 * Recovery uses SKIP LOCKED, so even a long atomic ONE_C transaction cannot be
 * stolen mid-commit. A late provider response cannot write through an old token.
 */
export async function lockLease(tx: Prisma.TransactionClient, lease: Lease) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM ${Prisma.raw('"' + lease.table + '"')}
    WHERE id = ${lease.id} AND "leaseToken" = ${lease.token}
      FOR UPDATE`)
  if (!rows.length) throw new LeaseLostError()
  // Evaluate expiry after acquiring the row lock, including after a rollback.
  const renewed = await tx.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw('"' + lease.table + '"')}
    SET "leaseExpiresAt" = clock_timestamp() + ${LEASE_MS} * interval '1 millisecond'
    WHERE id = ${lease.id} AND "leaseToken" = ${lease.token}
      AND "leaseExpiresAt" > clock_timestamp()`)
  if (!renewed) throw new LeaseLostError()
}

export function executionLease(client: PrismaClient, lease: Lease) {
  let stopped = false, transactions = 0
  const deadline = Date.now() + EXECUTION_MS
  const live = () => { if (stopped || Date.now() >= deadline) throw new LeaseLostError() }
  const transaction = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>, options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }) => {
    live()
    transactions += 1
    return client.$transaction(async tx => {
      live(); await lockLease(tx, lease)
      const result = await work(tx)
      live()
      await tx.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw('"' + lease.table + '"')}
        SET "leaseExpiresAt" = clock_timestamp() + ${LEASE_MS} * interval '1 millisecond'
        WHERE id = ${lease.id} AND "leaseToken" = ${lease.token}`)
      return result
    }, options).finally(() => { transactions -= 1 })
  }
  // The import services use both individual model operations and callback
  // transactions. Fence both without changing their existing commit boundaries.
  const fenced = new Proxy(client, {
    get(target, key) {
      if (key === '$transaction') return (work: unknown, options?: Parameters<typeof transaction>[1]) => {
        if (typeof work !== 'function') throw new Error('lease_requires_callback_transaction')
        return transaction(work as (tx: Prisma.TransactionClient) => Promise<unknown>, options)
      }
      const delegate = Reflect.get(target, key)
      if (typeof key === 'string' && !key.startsWith('$') && !key.startsWith('_') && delegate && typeof delegate === 'object') {
        return new Proxy(delegate, { get(_model, method) {
          if (typeof Reflect.get(delegate, method) !== 'function') return Reflect.get(delegate, method)
          return (...args: unknown[]) => transaction(tx => (tx as any)[key][method](...args))
        } })
      }
      if (typeof key === 'string' && key.startsWith('$')) throw new Error('unsupported_leased_client_operation')
      return delegate
    },
  }) as PrismaClient
  const transport = transports.get(client) ?? client
  transports.set(fenced, transport)
  let pulse: Promise<unknown> | undefined
  const timer = setInterval(() => {
    // A business transaction holds the lease row and renews it at commit.
    // Do not queue a heartbeat behind it that could renew after its rollback.
    if (pulse || stopped || transactions) return
    pulse = Promise.resolve().then(() => transaction(async () => undefined, { maxWait: 1_000, timeout: 130_000 }))
      .catch(() => { stopped = true }).finally(() => { pulse = undefined })
  }, LEASE_MS / 3)
  timer.unref()
  const stop = async () => { stopped = true; clearInterval(timer); await pulse }
  return {
    client: fenced,
    async recordJobFailure(failure: JobFailure) {
      if (lease.table !== 'IntegrationJob') throw new Error('job_lease_required')
      await stop()
      return persistJobFailure(transport, lease.id, lease.token, failure)
    },
    assert: () => transaction(async () => undefined),
    provider(provider: OperationalProvider): OperationalProvider {
      return new Proxy(provider, { get(target, key) {
        const value = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        return async (...args: unknown[]) => {
          await transaction(async () => undefined)
          let timeout: ReturnType<typeof setTimeout> | undefined
          try {
            const result = await Promise.race([
              value.apply(target, args),
              new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new LeaseLostError()), Math.max(1, deadline - Date.now())); timeout.unref() }),
            ])
            await transaction(async () => undefined)
            return result
          } finally { if (timeout) clearTimeout(timeout) }
        }
      } })
    },
    stop,
  }
}
