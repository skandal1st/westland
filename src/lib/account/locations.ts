import { assertCapability } from '@/lib/capabilities'
import { recordAudit } from '@/lib/audit'
import { buyerLocationsWhere, deliveryAccess, lockDeliveryAccess } from './location-access'
import { prisma } from '@/lib/db'
import type { SessionUser } from '@/lib/authz'

export class LocationError extends Error {
  constructor(public code: 'NO_CUSTOMER' | 'FORBIDDEN' | 'NOT_FOUND') {
    super(code)
    this.name = 'LocationError'
  }
}

export async function listBuyerLocations(user: SessionUser) {
  if (!user.customerId) return []
  return prisma.customerLocation.findMany({
    where: await buyerLocationsWhere(user),
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, address: true, city: true, contactName: true, contactPhone: true, isDefault: true },
  })
}

export async function createBuyerLocation(
  user: SessionUser,
  input: { name: string; address: string; city: string; contactName?: string; contactPhone?: string; isDefault?: boolean },
) {
  assertCapability('commerce-b2b')

  if (!user.customerId) throw new LocationError('NO_CUSTOMER')
  return prisma.$transaction(async (tx) => {
    await lockDeliveryAccess(user, tx)
    const access = await deliveryAccess(user, tx)
    if (!access) throw new LocationError('FORBIDDEN')
    const allowed = await buyerLocationsWhere(user, tx)
    if (input.isDefault) await tx.customerLocation.updateMany({ where: allowed, data: { isDefault: false } })
    const count = await tx.customerLocation.count({ where: allowed })
    const location = await tx.customerLocation.create({
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
    await tx.userDeliveryPointGrant.create({ data: { userId: user.id, locationId: location.id, assignedById: user.id, origin: 'SELF_CREATED' } })
    await recordAudit(tx, { storeId: user.storeId, actor: user, action: 'BuyerDeliveryPointCreated', targetType: 'CustomerLocation', targetId: location.id,
      metadata: { customerId: user.customerId, userId: user.id } })
    return location
  })
}

export async function createBuyerLocationForStaff(
  userId: string,
  actor: SessionUser,
  input: { name: string; address: string; city: string; contactName?: string; contactPhone?: string; isDefault?: boolean },
) {
  assertCapability('commerce-b2b')

  return prisma.$transaction(async (tx) => {
    const staff = await tx.user.findFirst({ where: { id: actor.id, storeId: actor.storeId, status: 'ACTIVE', role: { in: ['STAFF', 'ADMIN'] } } })
    if (!staff) throw new LocationError('FORBIDDEN')

    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} AND "storeId" = ${actor.storeId} FOR UPDATE`
    const buyer = await tx.user.findFirst({ where: { id: userId, storeId: actor.storeId, role: 'BUYER' }, select: { id: true, customerId: true } })
    if (!buyer?.customerId) throw new LocationError('NOT_FOUND')

    if (input.isDefault) await tx.customerLocation.updateMany({ where: { customerId: buyer.customerId }, data: { isDefault: false } })
    const count = await tx.customerLocation.count({ where: { customerId: buyer.customerId } })
    const location = await tx.customerLocation.create({
      data: {
        customerId: buyer.customerId,
        name: input.name,
        address: input.address,
        city: input.city,
        contactName: input.contactName ?? '',
        contactPhone: input.contactPhone ?? '',
        isDefault: input.isDefault ?? count === 0,
      },
    })
    await tx.userDeliveryPointGrant.create({ data: { userId: buyer.id, locationId: location.id, assignedById: actor.id, origin: 'MODERATOR' } })
    await recordAudit(tx, {
      storeId: actor.storeId,
      actor,
      action: 'StaffBuyerDeliveryPointCreated',
      targetType: 'CustomerLocation',
      targetId: location.id,
      metadata: { customerId: buyer.customerId, userId: buyer.id },
    })
    return location
  })
}
