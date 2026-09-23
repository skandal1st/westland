import { Prisma, type PrismaClient } from '@prisma/client'
import { OrderError } from './errors'

/** One MVCC view for every directory and price read. Retries only aborted transactions, never external I/O. */
export async function submitTransaction<T>(client: PrismaClient, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000, maxWait: 10_000 })
    } catch (error) {
      const retryable = error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2034' || (error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code))))
      if (!retryable) throw error
      if (attempt === 2) throw new OrderError('STATE_CHANGED')
    }
  }
  throw new OrderError('STATE_CHANGED')
}
