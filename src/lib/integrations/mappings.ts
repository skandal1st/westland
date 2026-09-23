import { assertCapability } from '@/lib/capabilities'
import { z } from 'zod'
import { WarehouseAddressSchema } from './warehouse-address'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma as db } from '@/lib/db'
import { IntegrationInputError as InputError } from './errors'
import { SellerRequisitesSchema } from '@/lib/invoices/requisites'
import { projectStoreAvailability } from '@/lib/pricing/availability'
import { recordAudit } from '@/lib/audit'

export const MappingSchema = z.object({
  entityType: z.enum(['location', 'priceType', 'customer', 'edCustomer', 'product', 'seller']),
  externalId: z.string().trim().min(1).max(200), entityId: z.string().min(1).max(200),
  seller: SellerRequisitesSchema.optional(),
  warehouseAddress: WarehouseAddressSchema.optional(),
}).strict().superRefine((v, ctx) => {
  if (v.entityType === 'edCustomer' && (!z.string().uuid().safeParse(v.externalId).success || v.externalId === '00000000-0000-0000-0000-000000000000')) ctx.addIssue({ code: 'custom', message: 'EnterpriseData counterparty requires a nonempty GUID' })
  if (v.warehouseAddress && v.entityType !== 'location') ctx.addIssue({ code: 'custom', message: 'Warehouse address requires a location mapping' })
  if ((v.entityType === 'seller') !== Boolean(v.seller)) ctx.addIssue({ code: 'custom', message: 'Seller mapping requires requisites; other mappings do not accept them' })
})
export const ChannelMappingSchema = z.object({
  channelId: z.string().min(1), warehouseExternalId: z.string().min(1), priceTypeExternalId: z.string().min(1), sellerExternalId: z.string().min(1),
}).strict()
type Tx = Prisma.TransactionClient
async function source(tx: Tx, storeId: string, connectionId: string) {
  await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${connectionId} FOR UPDATE`
  const row = await tx.integrationConnection.findFirst({ where: { id: connectionId, storeId, provider: 'ONE_C' } })
  if (!row) throw new InputError('source_not_found', 404)
  if (row.sourceState === 'RETIRED') throw new InputError('source_retired')
  if (await tx.integrationJob.count({ where: { connectionId, status: 'RUNNING' } })) throw new InputError('source_jobs_pending')
  return row
}
export async function saveSourceMapping(storeId: string, connectionId: string, payload: z.infer<typeof MappingSchema>, actor: { id: string; email: string }, client: PrismaClient | Tx = db) {
  assertCapability('commerce-core')

  const input = MappingSchema.parse(payload)
  const work = async (tx: Tx) => {
    await source(tx, storeId, connectionId)
    const where = { id: input.entityId, storeId }
    const target = input.entityType === 'location' ? await tx.inventoryLocation.findFirst({ where })
      : input.entityType === 'priceType' ? await tx.priceBook.findFirst({ where })
      : ['customer', 'edCustomer'].includes(input.entityType) ? await tx.customer.findFirst({ where })
      : input.entityType === 'product' ? await tx.product.findFirst({ where })
      : await tx.fulfillmentChannel.findFirst({ where })
    if (!target) throw new InputError('mapping_target_not_found', 404)
    if (input.entityType === 'customer' || input.entityType === 'edCustomer') {
      const edIdentity = await tx.externalReference.findMany({ where: { connectionId, entityType: 'edCustomerIdentity', OR: [{ entityId: input.entityId }, { externalId: input.externalId }] } })
      if (edIdentity.some(r => r.entityId !== input.entityId || r.externalId !== input.externalId)) throw new InputError('ed_customer_identity_changed')
    }
    if (input.entityType === 'customer') {
      const pinned = await tx.onecSaleCustomerIdentity.findMany({ where: { connectionId,
        OR: [{ customerId: input.entityId }, { xmlId: input.externalId }] } })
      if (pinned.some(row => row.customerId !== input.entityId || row.xmlId !== input.externalId)) {
        throw new InputError('sale_customer_identity_changed')
      }
    }
    const existing = await tx.externalReference.findUnique({ where: { connectionId_entityType_externalId: { connectionId, entityType: input.entityType, externalId: input.externalId } } })
    if (input.entityType === 'customer' && existing && existing.entityId !== input.entityId
      && await tx.onecSaleCustomerIdentity.count({ where: { connectionId, customerId: existing.entityId } })) {
      throw new InputError('sale_customer_identity_changed')
    }
    const collision = await tx.externalReference.findFirst({ where: { connectionId, entityType: input.entityType, entityId: input.entityId, externalId: { not: input.externalId } } })
    if (collision) throw new InputError('mapping_target_in_use')
    if (input.entityType === 'product') {
      if (existing && existing.entityId !== input.entityId) throw new InputError('product_remap_requires_migration')
      if (await tx.externalReference.count({ where: { entityType: 'product', entityId: input.entityId, connectionId: { not: connectionId } } })) throw new InputError('product_source_conflict')
    }
    if (existing && existing.entityId !== input.entityId) {
      if (input.entityType === 'location') {
        await tx.stock.deleteMany({ where: { sourceConnectionId: connectionId, sourceScopeKey: input.externalId } })
        await projectStoreAvailability(storeId, tx)
      }
      if (input.entityType === 'priceType') await tx.priceEntry.deleteMany({ where: { sourceConnectionId: connectionId, sourceScopeKey: input.externalId } })
    }
    const sourceData = input.seller ?? (input.warehouseAddress ? {
      ...(existing?.sourceData && typeof existing.sourceData === 'object' && !Array.isArray(existing.sourceData) ? existing.sourceData : {}),
      warehouseAddress: input.warehouseAddress,
    } : undefined)
    const row = await tx.externalReference.upsert({ where: { connectionId_entityType_externalId: { connectionId, entityType: input.entityType, externalId: input.externalId } },
      create: { connectionId, entityType: input.entityType, externalId: input.externalId, entityId: input.entityId, sourceData: sourceData as Prisma.InputJsonValue | undefined },
      update: { entityId: input.entityId, ...(sourceData ? { sourceData: sourceData as Prisma.InputJsonValue } : {}) } })
    await recordAudit(tx, { storeId, actor, action: 'SourceMappingChanged', targetType: 'IntegrationConnection', targetId: connectionId, metadata: { entityType: input.entityType, externalId: input.externalId, entityId: input.entityId } })
    return { id: row.id, entityType: row.entityType, externalId: row.externalId, entityId: row.entityId }
  }
  return '$transaction' in client ? client.$transaction(work) : work(client)
}

export async function saveSourceChannel(storeId: string, connectionId: string, payload: z.infer<typeof ChannelMappingSchema>, actor: { id: string; email: string }, client: PrismaClient = db) {
  assertCapability('commerce-core')

  const input = ChannelMappingSchema.parse(payload)
  return client.$transaction(async tx => {
    const profile = await source(tx, storeId, connectionId)
    const channel = await tx.fulfillmentChannel.findFirst({ where: { id: input.channelId, storeId } })
    if (!channel) throw new InputError('channel_not_found', 404)
    const refs = await tx.externalReference.findMany({ where: { connectionId } })
    const location = refs.find(r => r.entityType === 'location' && r.externalId === input.warehouseExternalId)
    const book = refs.find(r => r.entityType === 'priceType' && r.externalId === input.priceTypeExternalId)
    const seller = refs.find(r => r.entityType === 'seller' && r.externalId === input.sellerExternalId)
    const legal = SellerRequisitesSchema.safeParse(seller?.sourceData)
    if (!location || !book || !seller || !legal.success) throw new InputError('channel_mappings_incomplete')
    if (!await tx.inventoryLocation.findFirst({ where: { id: location.entityId, storeId } }) || !await tx.priceBook.findFirst({ where: { id: book.entityId, storeId } })) throw new InputError('mapping_target_not_found')
    await tx.externalReference.upsert({ where: { connectionId_entityType_externalId: { connectionId, entityType: 'channel', externalId: channel.id } },
      create: { connectionId, entityType: 'channel', externalId: channel.id, entityId: channel.id, sourceData: input }, update: { sourceData: input } })
    const applied = profile.sourceState === 'ACTIVE' && profile.enabled
    if (applied) {
      await tx.fulfillmentChannel.update({ where: { id: channel.id }, data: { inventoryLocationId: location.entityId, priceBookId: book.entityId, sellerLegalEntity: legal.data, invoiceProfile: {} } })
      await projectStoreAvailability(storeId, tx)
    }
    await recordAudit(tx, { storeId, actor, action: 'SourceChannelMapped', targetType: 'IntegrationConnection', targetId: connectionId, metadata: { ...input, applied } })
    return { applied }
  }, { timeout: 30_000 })
}

export async function listSourceMappings(storeId: string, connectionId: string, client: PrismaClient = db) {
  if (!await client.integrationConnection.findFirst({ where: { id: connectionId, storeId, provider: 'ONE_C' } })) throw new InputError('source_not_found', 404)
  const [mappings, locations, priceBooks, channels] = await Promise.all([
    client.externalReference.findMany({ where: { connectionId, entityType: { in: ['location', 'priceType', 'customer', 'edCustomer', 'product', 'seller', 'channel'] } }, select: { entityType: true, externalId: true, entityId: true, sourceData: true }, orderBy: [{ entityType: 'asc' }, { externalId: 'asc' }] }),
    client.inventoryLocation.findMany({ where: { storeId }, select: { id: true, name: true, code: true } }),
    client.priceBook.findMany({ where: { storeId }, select: { id: true, name: true, currency: true, code: true } }),
    client.fulfillmentChannel.findMany({ where: { storeId }, select: { id: true, name: true, code: true } }),
  ])
  return { mappings: mappings.map(m => ({ entityType: m.entityType, externalId: m.externalId, entityId: m.entityId, ...(['seller', 'channel', 'location'].includes(m.entityType) ? { details: m.sourceData } : {}) })), locations, priceBooks, channels }
}
