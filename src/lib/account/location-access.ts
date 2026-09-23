import { assertCapability } from '@/lib/capabilities'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import type { SessionUser } from '@/lib/authz'
import { recordAudit } from '@/lib/audit'

export class DeliveryAccessError extends Error {
  constructor(public code: 'FORBIDDEN' | 'INVALID_DELIVERY' | 'NOT_FOUND') { super(code) }
}

/** Read the current account, never a cached client/JWT access flag. */
export async function deliveryAccess(user: SessionUser, tx: Prisma.TransactionClient = prisma) {
  return tx.user.findFirst({ where: { id: user.id, storeId: user.storeId, customerId: user.customerId ?? '', status: 'ACTIVE' },
    select: { deliveryPointsRestricted: true } })
}
export async function buyerLocationsWhere(user: SessionUser, tx: Prisma.TransactionClient = prisma): Promise<Prisma.CustomerLocationWhereInput> {
  const access = await deliveryAccess(user, tx)
  return { customerId: user.customerId ?? '', customer: { storeId: user.storeId },
    ...(!access ? { id: { in: [] } } : access.deliveryPointsRestricted ? { userGrants: { some: { userId: user.id } } } : {}) }
}
/** Serialize grants/revocations with checkout/submit for this account. */
export async function lockDeliveryAccess(user: SessionUser, tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} AND "storeId" = ${user.storeId} FOR SHARE`
}
export async function setBuyerDeliveryPoints(userId: string, locationIds: string[], actor: SessionUser) {
  assertCapability('commerce-b2b')

  return prisma.$transaction(async tx => {
    if (!await tx.user.findFirst({ where: { id: actor.id, storeId: actor.storeId, status: 'ACTIVE', role: { in: ['STAFF', 'ADMIN'] } } })) throw new DeliveryAccessError('FORBIDDEN')
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} AND "storeId" = ${actor.storeId} FOR UPDATE`
    const buyer = await tx.user.findFirst({ where: { id: userId, storeId: actor.storeId, role: 'BUYER' } })
    if (!buyer?.customerId) throw new DeliveryAccessError('NOT_FOUND')
    const ids = Array.from(new Set(locationIds))
    if (ids.length > 200 || await tx.customerLocation.count({ where: { id: { in: ids }, customerId: buyer.customerId, customer: { storeId: actor.storeId } } }) !== ids.length) throw new DeliveryAccessError('INVALID_DELIVERY')
    await tx.user.update({ where: { id: userId }, data: { deliveryPointsRestricted: true } })
    await tx.userDeliveryPointGrant.deleteMany({ where: { userId } })
    await tx.userDeliveryPointGrant.createMany({ data: ids.map(locationId => ({ userId, locationId, assignedById: actor.id })) })
    await recordAudit(tx, { storeId: actor.storeId, actor, action: 'BuyerDeliveryPointsAssigned', targetType: 'User', targetId: userId, metadata: { locationIds: ids } })
    return { locationIds: ids }
  })
}
