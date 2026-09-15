import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Job detail: attempt log + persisted errors (DLQ inspection). */
export async function GET(_request: Request, { params }: { params: { jobId: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const job = await prisma.integrationJob.findFirst({
    where: { id: params.jobId, storeId: store.id },
    select: {
      id: true, type: true, status: true, attempts: true, maxAttempts: true, payload: true,
      availableAt: true, startedAt: true, finishedAt: true, lastError: true, createdAt: true,
      connection: { select: { id: true, name: true, provider: true } },
      attemptsLog: { orderBy: { attempt: 'asc' }, select: { attempt: true, status: true, error: true, stats: true, startedAt: true, finishedAt: true } },
      errors: { orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, code: true, message: true, createdAt: true } },
    },
  })
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ job })
}
