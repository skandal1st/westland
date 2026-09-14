import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response

  const url = new URL(request.url)
  const status = url.searchParams.get('status') ?? 'PENDING'
  const store = await getActiveStore()
  const requests = await prisma.registrationRequest.findMany({
    where: { storeId: store.id, ...(status === 'ALL' ? {} : { status: status as 'PENDING' | 'APPROVED' | 'REJECTED' }) },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true, email: true, contactName: true, phone: true, legalName: true, inn: true, kpp: true,
      status: true, comment: true, reviewedAt: true, createdAt: true,
    },
  })
  return NextResponse.json({ requests })
}
