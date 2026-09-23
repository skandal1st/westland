import { z } from 'zod'
import { IntegrationInputError } from '../errors'
// Legacy partnerAssignment is accepted on read for stored configurations only.
// New orders always carry the delivery point as human-readable text; no EPF marker.
export const EnterpriseDataProfileSchema = z.object({ enabled: z.literal(true), format: z.literal('ENTERPRISEDATA_1_20'), currency: z.literal('RUB'), timeZone: z.string().min(1), numberPrefix: z.string().regex(/^[A-Z]{2}$/).default('AX'), partnerAssignment: z.literal('TEST_PROCESSOR_V1').optional() }).strict()
export function enterpriseDataProfile(config: unknown) {
  const result = EnterpriseDataProfileSchema.safeParse((config as { saleExport?: unknown } | null)?.saleExport)
  if (!result.success) throw new IntegrationInputError('ed_orders_not_configured')
  return result.data
}
