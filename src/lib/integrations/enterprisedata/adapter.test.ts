import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture, now, peer, settings, snapshot } from '../../../../tests/fixtures/enterprisedata'
import { digest, ED_NS, envelope, inspectMessage, MESSAGE_NS, parseXml } from './message'
import { documentUuid, renderOrder, validateReferences } from './order'
import { initializeJournal, journalStatus, prepareOrder, recordReceipt } from './journal'

const paths: string[] = []
const temp = () => { const p = mkdtempSync(join(tmpdir(), 'axima-ed-unit-')); paths.push(p); return p }
afterEach(() => { paths.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })) })
const doc = '66666666-6666-4666-8666-666666666666'
const receipt = (messageNo = 1, receivedNo = 1) => Buffer.from(envelope({ ...peer, messageNo, receivedNo }, [], now))

describe('EnterpriseData offline pilot', () => {
  it('negotiates only supported settings, preserves routing and creates no business body', () => {
    const dir = temp(), result = initializeJournal(dir, settings, now), m = inspectMessage(Buffer.from(result.xml))
    expect(m.confirmation).toEqual({ ...peer, from: peer.to, to: peer.from })
    expect(m.hasBody).toBe(false)
    expect(initializeJournal(dir, settings, '2027-01-01T00:00:00Z')).toEqual({ ...result, reused: true })
    expect(() => initializeJournal(temp(), Buffer.from(settings.toString().replace('1.20', '1.25')))).toThrow('ed_version_not_supported')
    expect(() => initializeJournal(temp(), receipt())).toThrow('ed_settings_required')
    expect(() => initializeJournal(dir, Buffer.from(settings.toString().replace('OFFLINE-1C', 'OTHER')))).toThrow('ed_journal_already_initialized')
  })
  it('honors explicit object receiving capabilities', () => {
    const caps = '<msg:AvailableObjectTypes><msg:ObjectType><msg:Name>Документ.ЗаказКлиента</msg:Name><msg:Sending>*</msg:Sending><msg:Receiving>1.25</msg:Receiving></msg:ObjectType></msg:AvailableObjectTypes>'
    const xml = settings.toString().replace('</msg:Header>', caps + '</msg:Header>')
    expect(() => initializeJournal(temp(), Buffer.from(xml))).toThrow('ed_peer_cannot_receive_order')
    expect(initializeJournal(temp(), Buffer.from(xml.replace('<msg:Receiving>1.25', '<msg:Receiving>*'))).reused).toBe(false)
  })
  it.each([
    ['DTD', '<!DOCTYPE Message [<!ENTITY x "boom">]>' + settings.toString().split('\n')[1], 'ed_doctype_forbidden'],
    ['wrong header namespace', settings.toString().replace(MESSAGE_NS, 'urn:fake'), 'ed_header_required'],
    ['duplicate header', settings.toString().replace('</Message>', settings.toString().match(/<msg:Header>[\s\S]*<\/msg:Header>/)![0] + '</Message>'), 'ed_duplicate_element'],
    ['negative counter', settings.toString().replace('<msg:MessageNo>0', '<msg:MessageNo>-1'), 'ed_invalid_message_number'],
    ['overflow counter', settings.toString().replace('<msg:MessageNo>0', '<msg:MessageNo>999999999999999999'), 'ed_invalid_message_number'],
    ['mixed envelope text', settings.toString().replace('</Message>', 'surprise</Message>'), 'ed_invalid_envelope_content'],
    ['wrong body namespace', receipt().toString().replace('<Body xmlns="' + ED_NS, '<Body xmlns="urn:fake'), 'ed_body_namespace'],
  ])('rejects %s', (_, xml, error) => { expect(() => inspectMessage(Buffer.from(xml))).toThrow(error) })
  it('rejects malformed encoding and deep trees', () => {
    expect(() => parseXml(Buffer.from([0xff, 0xfe]))).toThrow('ed_utf8_required')
    expect(() => parseXml(Buffer.from('<a>'.repeat(49) + '</a>'.repeat(49)))).toThrow('ed_xml_complexity')
  })
  it('serializes accepted delivery, IP, VAT and immutable references with XML escaping', () => {
    const { input, evidence } = fixture(); validateReferences(input, evidence, peer)
    const xml = renderOrder(input, doc)
    expect(xml).toContain('<СпособДоставки>ДоКлиента</СпособДоставки>')
    expect(xml).toContain('<АдресДоставки>Тестовый город, Тестовая &lt;улица&gt;, 8</АдресДоставки>')
    expect(xml).toContain('<ИндивидуальныйПредприниматель>true</ИндивидуальныйПредприниматель>')
    expect(xml).toContain('<СуммаНДС>48.69</СуммаНДС>')
    expect(xml).toContain('<СостояниеОбъекта>Черновик</СостояниеОбъекта>')
    expect(xml).not.toContain('<Партнер>')
    expect(renderOrder({ ...input, deliveryMethod: 'Самовывоз' }, doc)).toContain('<СпособДоставки>Самовывоз</СпособДоставки>')
  })
  it.each([
    ['legacy order', { ...snapshot, orderId: 'r22-old' }, 'ed_new_test_document_required'],
    ['bad total', { ...snapshot, total: '271.00' }, 'ed_snapshot_invalid'],
    ['bad VAT', { ...snapshot, tax: { ...snapshot.tax, amount: '0.00' } }, 'ed_snapshot_invalid'],
    ['missing address', { ...snapshot, delivery: { ...snapshot.delivery, address: '' } }, 'ed_delivery_address_required'],
    ['zero quantity', { ...snapshot, total: '0.00', tax: { ...snapshot.tax, subtotal: '0.00', amount: '0.00' }, lines: [{ ...snapshot.lines[0], quantity: '0', lineTotal: '0.00' }] }, 'ed_snapshot_invalid'],
  ])('rejects %s', (_, value, error) => { expect(() => renderOrder({ ...fixture().input, snapshot: value }, doc)).toThrow(error) })
  it('rejects guessed references, units, source and unsupported partner field', () => {
    const { input, evidence } = fixture()
    expect(() => validateReferences({ ...input, references: { ...input.references, counterparty: doc } }, evidence, peer)).toThrow('ed_reference_not_observed')
    expect(() => validateReferences(input, evidence, { ...peer, from: 'other' })).toThrow('ed_reference_source_mismatch')
    expect(() => validateReferences(input, Buffer.from(evidence.toString() + ' '), peer)).toThrow('ed_reference_evidence_mismatch')
    expect(() => validateReferences({ ...input, references: { ...input.references, products: [{ ...input.references.products[0], unitCode: '166' }] } }, evidence, peer)).toThrow('ed_product_unit_not_observed')
    expect(() => renderOrder({ ...input, partnerRef: doc }, doc)).toThrow()
    const wrong = Buffer.from(evidence.toString().replace('<ИндивидуальныйПредприниматель>true', '<ИндивидуальныйПредприниматель>false'))
    expect(() => validateReferences({ ...input, references: { ...input.references, evidenceSha256: digest(wrong) } }, wrong, peer)).toThrow('ed_ip_evidence_required')
  })
  it('journals exact bytes before export, retries exactly once and rejects changed or duplicate orders', () => {
    const dir = temp(), { input, evidence } = fixture(); initializeJournal(dir, settings, now)
    const first = prepareOrder(dir, input, evidence, now)
    const second = prepareOrder(dir, input, evidence, '2027-01-01T00:00:00Z')
    expect(second).toEqual({ ...first, reused: true })
    expect(() => prepareOrder(dir, { ...input, deliveryMethod: 'Самовывоз' }, evidence)).toThrow('ed_idempotency_conflict')
    expect(() => prepareOrder(dir, { ...input, requestKey: 'other' }, evidence)).toThrow('ed_duplicate_document')
    const next = { ...input, requestKey: 'next', snapshot: { ...snapshot, orderId: 'ed-test:2', number: 'ED-TEST-2' } }
    expect(() => prepareOrder(dir, next, evidence)).toThrow('ed_previous_message_unacknowledged')
    expect(recordReceipt(dir, receipt()).acknowledged).toBe(1)
    expect(recordReceipt(dir, receipt()).reused).toBe(true)
    const secondPacket = prepareOrder(dir, next, evidence)
    expect(secondPacket.messageNo).toBe(2); expect(secondPacket.documentId).not.toBe(first.documentId)
    expect(inspectMessage(Buffer.from(secondPacket.xml)).confirmation.receivedNo).toBe(0)
    expect(journalStatus(dir)).toMatchObject({ sent: 2, acknowledged: 1, incomingApplied: 0 })
  })
  it('rejects foreign, fabricated, changed and regressing receipts; never applies incoming data', () => {
    const dir = temp(), { input, evidence } = fixture(); initializeJournal(dir, settings, now); prepareOrder(dir, input, evidence, now)
    expect(() => recordReceipt(dir, receipt(1, 2))).toThrow('ed_receipt_counter_invalid')
    expect(() => recordReceipt(dir, Buffer.from(receipt().toString().replace('OFFLINE-1C', 'OTHER')))).toThrow('ed_receipt_source_mismatch')
    const incoming = Buffer.from(evidence.toString().replace('<msg:ReceivedNo>0', '<msg:ReceivedNo>1'))
    expect(recordReceipt(dir, incoming)).toMatchObject({ acknowledged: 1, receivedObjectsNotApplied: 1 })
    expect(() => recordReceipt(dir, receipt())).toThrow('ed_receipt_conflict')
    expect(() => recordReceipt(dir, receipt(2, 0))).toThrow('ed_receipt_counter_invalid')
    expect(journalStatus(dir).incomingApplied).toBe(0)
  })
  it('fails closed with concurrent writer or altered persisted packet', () => {
    const dir = temp(), { input, evidence } = fixture(); initializeJournal(dir, settings, now)
    writeFileSync(join(dir, '.lock'), 'other-process')
    expect(() => prepareOrder(dir, input, evidence)).toThrow('ed_journal_locked')
    rmSync(join(dir, '.lock')); prepareOrder(dir, input, evidence, now)
    const path = join(dir, 'journal.json'), state = JSON.parse(readFileSync(path, 'utf8'))
    state.entries[0].xml += ' '; writeFileSync(path, JSON.stringify(state))
    expect(() => journalStatus(dir)).toThrow('ed_journal_corrupt')
  })
  it('preserves no-VAT amounts and rejects unsupported VAT profiles', () => {
    const { input } = fixture()
    const noVat = { ...snapshot, seller: { ...snapshot.seller!, vatEnabled: false }, tax: { mode: 'NO_VAT', rate: null, subtotal: '270.00', amount: '0.00' } }
    const xml = renderOrder({ ...input, snapshot: noVat }, doc)
    expect(xml).toContain('<НеОблагается>true</НеОблагается><ВидСтавки>БезНДС</ВидСтавки>')
    expect(xml).toContain('<СуммаНДС>0.00</СуммаНДС>')
    const lower = { ...snapshot, seller: { ...snapshot.seller!, vatRate: 10 }, tax: { mode: 'GROSS_INCLUDED', rate: 10, subtotal: '245.45', amount: '24.55' } }
    expect(() => renderOrder({ ...input, snapshot: lower }, doc)).toThrow('ed_vat_rate_not_supported')
  })
  it('preserves fractional-line rounding and total VAT allocation', () => {
    const { input } = fixture()
    const terms = { ...snapshot, total: '0.02', tax: { ...snapshot.tax, amount: '0.00', subtotal: '0.02' }, lines: ['a', 'b'].map(id => ({ ...snapshot.lines[0], id, quantity: '0.1', unitPrice: '0.05', lineTotal: '0.01' })) }
    const xml = renderOrder({ ...input, snapshot: terms }, doc)
    expect(xml.match(/<Сумма>0.01<\/Сумма>/g)).toHaveLength(2)
    expect(xml.match(/<СуммаНДС>0.00<\/СуммаНДС>/g)).toHaveLength(2)
  })
  it('fails closed when peer declares an empty receiving object list', () => {
    expect(() => initializeJournal(temp(), Buffer.from(settings.toString().replace('</msg:Header>', '<msg:AvailableObjectTypes/></msg:Header>')))).toThrow('ed_peer_cannot_receive_order')
  })
  it('generates stable document identities scoped to the peer journal', () => {
    expect(documentUuid(doc, 'a')).toBe(documentUuid(doc, 'a'))
    expect(documentUuid(doc, 'a')).not.toBe(documentUuid(doc, 'b'))
    expect(documentUuid(doc, 'a')).toMatch(/^[a-f0-9-]{14}5/)
  })
})
