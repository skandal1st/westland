import { prisma } from '@/lib/db'
import type { SessionUser } from '@/lib/authz'

export class LocationError extends Error {
  constructor(public code: 'NO_CUSTOMER') {
    super(code)
    this.name = 'LocationError'
  }
}

export async function listBuyerLocations(user: SessionUser) {
  if (!user.customerId) return []
  return prisma.customerLocation.findMany({
    where: { customerId: user.customerId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, address: true, city: true, contactName: true, contactPhone: true, isDefault: true },
  })
}

export async function createBuyerLocation(
  user: SessionUser,
  input: { name: string; address: string; city: string; contactName?: string; contactPhone?: string; isDefault?: boolean },
) {
  if (!user.customerId) throw new LocationError('NO_CUSTOMER')
  return prisma.$transaction(async (tx) => {
    if (input.isDefault) await tx.customerLocation.updateMany({ where: { customerId: user.customerId! }, data: { isDefault: false } })
    const count = await tx.customerLocation.count({ where: { customerId: user.customerId! } })
    return tx.customerLocation.create({
      data: {
        customerId: user.customerId!,
        name: input.name,
        address: input.address,
        city: input.city,
        contactName: input.contactName ?? '',
        contactPhone: input.contactPhone ?? '',
        isDefault: input.isDefault ?? count === 0,
      },
    })
  })
}
