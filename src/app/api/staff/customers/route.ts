import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const customers = await prisma.customer.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true, displayName: true, legalName: true, inn: true,
      priceAssignment: { select: { priceGroupId: true, priceGroup: { select: { code: true, name: true } } } },
    },
  })
  return NextResponse.json({
    customers: customers.map((c) => ({
      id: c.id, displayName: c.displayName, legalName: c.legalName, inn: c.inn,
      priceGroupId: c.priceAssignment?.priceGroupId ?? null,
      priceGroup: c.priceAssignment?.priceGroup ? { code: c.priceAssignment.priceGroup.code, name: c.priceAssignment.priceGroup.name } : null,
    })),
  })
}
