import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response

  const url = new URL(request.url)
  const status = url.searchParams.get('status') ?? 'PENDING'
  const requests = await prisma.registrationRequest.findMany({
    where: { storeId: auth.user.storeId, ...(status === 'ALL' ? {} : { status: status as 'PENDING' | 'APPROVED' | 'REJECTED' }) },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true, email: true, contactName: true, phone: true, legalName: true, inn: true, kpp: true,
      status: true, comment: true, reviewedAt: true, createdAt: true,
    },
  })
  const customers = await prisma.customer.findMany({ where: { storeId: auth.user.storeId, inn: { in: requests.map(r => r.inn) } },
    select: { inn: true, kpp: true, locations: { select: { id: true, name: true, city: true, address: true }, orderBy: { name: 'asc' } } } })
  const byInn = new Map(customers.map(customer => [customer.inn, customer]))
  return NextResponse.json({ requests: requests.map(request => {
    const customer = byInn.get(request.inn)
    return { ...request, deliveryLocations: customer && (customer.kpp ?? '') === (request.kpp ?? '') ? customer.locations : [] }
  }) })
}
