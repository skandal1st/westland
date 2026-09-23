import { assertCapability } from '@/lib/capabilities'
import { EnterpriseDataProfileSchema } from './enterprisedata/profile'
import { z } from 'zod'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma as db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { IntegrationInputError } from './errors'
import { SaleProfileSchema } from './onec/sale-document'

export const OrderDeliveryConfigSchema = z.union([SaleProfileSchema, EnterpriseDataProfileSchema, z.object({ enabled: z.literal(false) }).strict()])
export async function configureOrderDelivery(storeId: string, connectionId: string, payload: unknown, actor: { id: string; email: string }, client: PrismaClient = db) {
  assertCapability('commerce-core')

  const config = OrderDeliveryConfigSchema.parse(payload)
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${connectionId} FOR UPDATE`
    const source = await tx.integrationConnection.findFirst({ where: { id: connectionId, storeId } })
    if (!source) throw new IntegrationInputError('source_not_found', 404)
    if (source.provider !== 'ONE_C') throw new IntegrationInputError('order_delivery_unsupported')
    if (source.sourceState === 'RETIRED') throw new IntegrationInputError('source_retired')
    if (config.enabled && config.format === 'ENTERPRISEDATA_1_20' && config.partnerAssignment) throw new IntegrationInputError('ed_partner_processor_retired')
    if (config.enabled) {
      try { new Intl.DateTimeFormat('en', { timeZone: config.timeZone }).format() }
      catch { throw new IntegrationInputError('sale_timezone_invalid') }
    }
    if (await tx.orderExport.count({ where: { connectionId, status: 'AWAITING_ACK' } })) throw new IntegrationInputError('sale_receipts_pending')
    const sequence = await tx.enterpriseDataSequence.findUnique({ where: { connectionId } })
    if (sequence && config.enabled && config.format === 'ENTERPRISEDATA_1_20' && sequence.prefix !== config.numberPrefix) throw new IntegrationInputError('ed_number_prefix_frozen')
    const previous = source.config && typeof source.config === 'object' && !Array.isArray(source.config) ? source.config : {}
    await tx.integrationConnection.update({ where: { id: source.id }, data: { config: { ...previous, saleExport: config } as Prisma.InputJsonValue, exchangeRevision: { increment: 1 } } })
    await recordAudit(tx, { storeId, actor, action: 'OrderDeliveryConfigured', targetType: 'IntegrationConnection', targetId: source.id, metadata: config })
    return config
  })
}
