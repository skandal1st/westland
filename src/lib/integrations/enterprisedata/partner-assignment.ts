import { z } from 'zod'
import { IntegrationInputError } from '../errors'

export const PARTNER_MARKER = 'AXIMA.Partner/1|'
const guid = z.string().uuid().refine(v => v !== '00000000-0000-0000-0000-000000000000')
export const PartnerAssignmentSchema = z.object({
  connectionId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  documentId: guid, number: z.string().regex(/^[A-Z]{2}\d{9}$/),
  partnerId: guid, counterpartyId: guid, organizationId: guid,
}).strict()
export type PartnerAssignment = z.infer<typeof PartnerAssignmentSchema>
/** A supplemental test-processor instruction in the standard comment, not a new ED XML field. */
export function partnerAssignmentLine(value: PartnerAssignment) {
  const a = PartnerAssignmentSchema.parse(value)
  return PARTNER_MARKER + [a.connectionId, a.documentId, a.number, a.partnerId, a.counterpartyId, a.organizationId].join('|')
}
export function readPartnerAssignment(comment: string): PartnerAssignment {
  const line = comment.split(/\r?\n/, 1)[0]
  if (!line.startsWith(PARTNER_MARKER) || comment.indexOf(PARTNER_MARKER, PARTNER_MARKER.length) !== -1) throw new IntegrationInputError('ed_partner_marker_invalid')
  const [connectionId, documentId, number, partnerId, counterpartyId, organizationId, extra] = line.slice(PARTNER_MARKER.length).split('|')
  if (extra !== undefined) throw new IntegrationInputError('ed_partner_marker_invalid')
  return PartnerAssignmentSchema.parse({ connectionId, documentId, number, partnerId, counterpartyId, organizationId })
}
