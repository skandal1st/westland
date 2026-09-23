import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response

  const customers = await prisma.customer.findMany({
    where: { storeId: auth.user.storeId },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: {
      id: true, displayName: true, legalName: true, inn: true,
      locations: { select: { id: true, name: true, city: true, address: true }, orderBy: { name: 'asc' } },
      users: { where: { role: 'BUYER', storeId: auth.user.storeId }, select: { id: true, email: true, deliveryPointsRestricted: true, deliveryPointGrants: { select: { locationId: true } } } },
      priceAssignment: { select: { priceGroupId: true, priceGroup: { select: { code: true, name: true } } } },
    },
  })
  return NextResponse.json({
    customers: customers.map((c) => ({
      id: c.id, displayName: c.displayName, legalName: c.legalName, inn: c.inn,
      locations: c.locations, users: c.users.map(user => ({ id: user.id, email: user.email, restricted: user.deliveryPointsRestricted, locationIds: user.deliveryPointGrants.map(grant => grant.locationId) })),
      priceGroupId: c.priceAssignment?.priceGroupId ?? null,
      priceGroup: c.priceAssignment?.priceGroup ? { code: c.priceAssignment.priceGroup.code, name: c.priceAssignment.priceGroup.name } : null,
    })),
  })
}
