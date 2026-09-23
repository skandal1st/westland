import { expect, it } from 'vitest'
import { fixture } from '../../../../tests/fixtures/enterprisedata'
import { partnerAssignmentLine, readPartnerAssignment, PARTNER_MARKER } from './partner-assignment'
import { renderWebsiteOrder } from './order'
const a = { connectionId: 'r22-source', documentId: '66666666-6666-4666-8666-666666666666', number: 'AX000000002', partnerId: '77777777-7777-4777-8777-777777777777', counterpartyId: '22222222-2222-4222-8222-222222222222', organizationId: '44444444-4444-4444-8444-444444444444' }
it('parses a single first-line assignment and rejects ambiguous or corrupt instructions', () => {
  const line = partnerAssignmentLine(a)
  expect(readPartnerAssignment(line + '\r\nHuman note')).toEqual(a)
  for (const invalid of [line + '|extra', 'note\n' + line, line + '\n' + line, line.replace(a.partnerId, 'bad'), line.replace(a.partnerId, '00000000-0000-0000-0000-000000000000')]) expect(() => readPartnerAssignment(invalid)).toThrow()
})
it('rejects production, mismatched order identity and buyer-supplied reserved markers', () => {
  const input = fixture().input
  const { organization, counterparty, warehouse, products } = input.references
  const refs = { organization, counterparty, warehouse, products }
  const assignment = { ...a, counterpartyId: refs.counterparty, organizationId: refs.organization }
  expect(() => renderWebsiteOrder(input.snapshot, refs, a.documentId, a.number, false, assignment)).toThrow('ed_partner_assignment_mismatch')
  expect(() => renderWebsiteOrder(input.snapshot, refs, a.documentId, 'AX000000003', true, assignment)).toThrow('ed_partner_assignment_mismatch')
  expect(() => renderWebsiteOrder({ ...(input.snapshot as object), comment: PARTNER_MARKER + 'injection' }, refs, a.documentId, a.number, true, assignment)).toThrow('ed_partner_marker_reserved')
})
