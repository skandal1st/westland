import { assertCapability } from '@/lib/capabilities'
import type { PaymentMethod, PrismaClient, Prisma } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { projectChannelAvailability } from './availability'
import { AuditAction, recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/authz'

/**
 * Commercial-policy setup. FulfillmentChannel is the domain concept binding
 * payment method + warehouse + price book + seller/invoice profile — there is
 * NO hardcoded cash=warehouseA/bank=warehouseB anywhere.
 */
type Client = PrismaClient

export function createInventoryLocation(input: { storeId: string; code: string; name: string }, client: Client = defaultPrisma) {
  assertCapability('commerce-core')

  return client.inventoryLocation.upsert({
    where: { storeId_code: { storeId: input.storeId, code: input.code } },
    update: { name: input.name },
    create: { storeId: input.storeId, code: input.code, name: input.name },
  })
}

export function createPriceBook(input: { storeId: string; code: string; name: string; currency?: string; isDefault?: boolean }, client: Client = defaultPrisma) {
  assertCapability('commerce-core')

  return client.priceBook.upsert({
    where: { storeId_code: { storeId: input.storeId, code: input.code } },
    update: { name: input.name, currency: input.currency ?? undefined, isDefault: input.isDefault ?? undefined },
    create: { storeId: input.storeId, code: input.code, name: input.name, currency: input.currency ?? 'RUB', isDefault: input.isDefault ?? false },
  })
}

export function createPriceGroup(input: { storeId: string; code: string; name: string; priceBookId?: string; priority?: number }, client: Client = defaultPrisma) {
  assertCapability('commerce-b2b')

  return client.priceGroup.upsert({
    where: { storeId_code: { storeId: input.storeId, code: input.code } },
    update: { name: input.name, priceBookId: input.priceBookId ?? undefined, priority: input.priority ?? undefined },
    create: { storeId: input.storeId, code: input.code, name: input.name, priceBookId: input.priceBookId, priority: input.priority ?? 100 },
  })
}

export async function upsertFulfillmentChannel(
  input: {
    storeId: string
    code: string
    name: string
    paymentMethod: PaymentMethod
    inventoryLocationId: string
    priceGroupId?: string | null
    priceBookId?: string | null
    sellerLegalEntity?: Prisma.InputJsonValue
    invoiceProfile?: Prisma.InputJsonValue
    isActive?: boolean
    sortOrder?: number
    actor?: SessionUser | null
  },
  client: Client = defaultPrisma,
) {
  assertCapability('commerce-core')

  return client.$transaction(async (tx) => {
    const channel = await tx.fulfillmentChannel.upsert({
      where: { storeId_code: { storeId: input.storeId, code: input.code } },
      update: {
        name: input.name, paymentMethod: input.paymentMethod, inventoryLocationId: input.inventoryLocationId,
        priceGroupId: input.priceGroupId ?? null, priceBookId: input.priceBookId ?? null,
        sellerLegalEntity: input.sellerLegalEntity, invoiceProfile: input.invoiceProfile,
        isActive: input.isActive ?? undefined, sortOrder: input.sortOrder ?? undefined,
      },
      create: {
        storeId: input.storeId, code: input.code, name: input.name, paymentMethod: input.paymentMethod,
        inventoryLocationId: input.inventoryLocationId, priceGroupId: input.priceGroupId ?? null, priceBookId: input.priceBookId ?? null,
        sellerLegalEntity: input.sellerLegalEntity, invoiceProfile: input.invoiceProfile,
        isActive: input.isActive ?? true, sortOrder: input.sortOrder ?? 0,
      },
    })
    await projectChannelAvailability(channel.id, tx)
    await recordAudit(tx, {
      storeId: input.storeId, actor: input.actor, action: AuditAction.FulfillmentChannelChanged,
      targetType: 'FulfillmentChannel', targetId: channel.id, summary: `Channel ${channel.code} configured`,
    })
    return channel
  })
}

export async function listActiveChannels(storeId: string, client: Client = defaultPrisma) {
  return client.fulfillmentChannel.findMany({
    where: { storeId, isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, code: true, name: true, paymentMethod: true },
  })
}
