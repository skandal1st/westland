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

export class FulfillmentChannelUpdateError extends Error {
  constructor(public code: 'NOT_FOUND' | 'INVALID_REFERENCE' | 'CODE_EXISTS') {
    super(code)
    this.name = 'FulfillmentChannelUpdateError'
  }
}

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

export async function updateFulfillmentChannel(
  input: {
    storeId: string
    channelId: string
    code: string
    name: string
    paymentMethod: PaymentMethod
    inventoryLocationId: string
    priceBookId: string | null
    isActive: boolean
    actor: SessionUser
  },
  client: Client = defaultPrisma,
) {
  assertCapability('commerce-core')

  try {
    return await client.$transaction(async (tx) => {
      const [current, location, priceBook] = await Promise.all([
        tx.fulfillmentChannel.findFirst({
          where: { id: input.channelId, storeId: input.storeId },
          select: { id: true, code: true, name: true, paymentMethod: true, inventoryLocationId: true, priceBookId: true, isActive: true },
        }),
        tx.inventoryLocation.findFirst({ where: { id: input.inventoryLocationId, storeId: input.storeId }, select: { id: true } }),
        input.priceBookId
          ? tx.priceBook.findFirst({ where: { id: input.priceBookId, storeId: input.storeId }, select: { id: true } })
          : Promise.resolve(null),
      ])
      if (!current) throw new FulfillmentChannelUpdateError('NOT_FOUND')
      if (!location || (input.priceBookId && !priceBook)) throw new FulfillmentChannelUpdateError('INVALID_REFERENCE')

      const channel = await tx.fulfillmentChannel.update({
        where: { id: current.id },
        data: {
          code: input.code,
          name: input.name,
          paymentMethod: input.paymentMethod,
          inventoryLocationId: input.inventoryLocationId,
          priceBookId: input.priceBookId,
          isActive: input.isActive,
        },
        select: { id: true, code: true, name: true, paymentMethod: true, inventoryLocationId: true, priceBookId: true, isActive: true },
      })
      await projectChannelAvailability(channel.id, tx)
      await recordAudit(tx, {
        storeId: input.storeId,
        actor: input.actor,
        action: AuditAction.FulfillmentChannelChanged,
        targetType: 'FulfillmentChannel',
        targetId: channel.id,
        summary: `Channel ${channel.code} updated`,
        metadata: { before: current, after: channel },
      })
      return channel
    })
  } catch (error) {
    if (error instanceof FulfillmentChannelUpdateError) throw error
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      throw new FulfillmentChannelUpdateError('CODE_EXISTS')
    }
    throw error
  }
}

export async function listActiveChannels(storeId: string, client: Client = defaultPrisma) {
  return client.fulfillmentChannel.findMany({
    where: { storeId, isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, code: true, name: true, paymentMethod: true },
  })
}
