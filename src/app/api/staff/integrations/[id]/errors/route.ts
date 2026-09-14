import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const errors = await prisma.integrationError.findMany({
    where: { storeId: store.id, connectionId: params.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, code: true, message: true, createdAt: true, jobId: true },
  })
  return NextResponse.json({ errors })
}
