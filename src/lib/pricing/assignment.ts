import { prisma } from '@/lib/db'
import { AuditAction, recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/authz'

/**
 * Assign a buyer (customer) to a price group. Authoritative assignment replacing
 * User.priceGroupId; audited as PriceGroupChanged.
 */
export async function assignBuyerPriceGroup(
  input: { storeId: string; customerId: string; priceGroupId: string; actor: SessionUser | null },
) {
  return prisma.$transaction(async (tx) => {
    const assignment = await tx.buyerPriceAssignment.upsert({
      where: { customerId: input.customerId },
      update: { priceGroupId: input.priceGroupId, assignedById: input.actor?.id ?? null },
      create: { storeId: input.storeId, customerId: input.customerId, priceGroupId: input.priceGroupId, assignedById: input.actor?.id ?? null },
    })
    await recordAudit(tx, {
      storeId: input.storeId,
      actor: input.actor,
      action: AuditAction.PriceGroupChanged,
      targetType: 'Customer',
      targetId: input.customerId,
      summary: 'Assigned price group',
      metadata: { priceGroupId: input.priceGroupId },
    })
    return assignment
  })
}
