import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(_request: Request, { params }: { params: { id: string; runId: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const run = await prisma.syncRun.findFirst({ where: { id: params.runId, connectionId: params.id, connection: { storeId: store.id } },
    select: { id: true, status: true, stats: true, createdAt: true, startedAt: true, finishedAt: true } })
  if (!run) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json(run)
}
