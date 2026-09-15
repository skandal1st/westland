import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Jobs for a connection with attempt/error counts — the integration ops view. */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const connection = await prisma.integrationConnection.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true } })
  if (!connection) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const jobs = await prisma.integrationJob.findMany({
    where: { connectionId: connection.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true, type: true, status: true, attempts: true, maxAttempts: true,
      availableAt: true, startedAt: true, finishedAt: true, lastError: true, createdAt: true,
      _count: { select: { attemptsLog: true, errors: true } },
    },
  })
  return NextResponse.json({
    jobs: jobs.map((j) => ({
      id: j.id, type: j.type, status: j.status, attempts: j.attempts, maxAttempts: j.maxAttempts,
      availableAt: j.availableAt, startedAt: j.startedAt, finishedAt: j.finishedAt, lastError: j.lastError, createdAt: j.createdAt,
      attemptCount: j._count.attemptsLog, errorCount: j._count.errors,
      retryable: j.status !== 'SUCCEEDED' && j.status !== 'RUNNING',
    })),
  })
}
