import { PARTNER_MARKER, partnerAssignmentLine, type PartnerAssignment } from './partner-assignment'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { readCommercialSnapshot, type CommercialSnapshot } from '@/lib/orders/commercial-snapshot'
import { saleLineTaxes } from '../onec/sale-document'
import { digest, ED_NS, element as el, fail, inspectMessage, child, type XmlNode } from './message'

const uuid = z.string().uuid().refine(v => !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v), 'empty reference')
export const ReferencesSchema = z.object({
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/), organization: uuid, counterparty: uuid, warehouse: uuid,
  products: z.array(z.object({ variantId: z.string().min(1), ref: uuid, unitCode: z.string().regex(/^\d{3}$/), unitName: z.string().min(1) }).strict()).min(1),
}).strict()
export type OrderReferences = z.infer<typeof ReferencesSchema>
export const OrderInputSchema = z.object({
  testOnly: z.literal(true), requestKey: z.string().min(1).max(100), deliveryMethod: z.enum(['ДоКлиента', 'Самовывоз']),
  snapshot: z.unknown(), references: ReferencesSchema,
}).strict()
export type OrderInput = z.infer<typeof OrderInputSchema>

/** This UUID identifies a NEW external document, never a fabricated existing 1C object. */
export function documentUuid(namespace: string, key: string) {
  uuid.parse(namespace)
  const hash = createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(key).digest().subarray(0, 16)
  hash[6] = (hash[6] & 0x0f) | 0x50; hash[8] = (hash[8] & 0x3f) | 0x80
  const hex = hash.toString('hex'); return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}
function keyNodes(objects: XmlNode[], field: string, entity: string) {
  const found: XmlNode[] = []
  function walk(node: XmlNode, parent?: XmlNode) {
    if (node.ns === ED_NS && (node.name === field || node.name === 'КлючевыеСвойства' && parent?.name === entity && parent.ns === ED_NS)) found.push(node)
    node.children.forEach(n => walk(n, node))
  }
  objects.forEach(n => walk(n)); return found
}
export function validateReferences(input: OrderInput, evidence: Buffer, peer: { from: string; to: string; plan: string }) {
  const message = inspectMessage(evidence)
  if (message.sha256 !== input.references.evidenceSha256 || message.format !== ED_NS) fail('ed_reference_evidence_mismatch')
  const c = message.confirmation
  if (c.from !== peer.from || c.to !== peer.to || c.plan !== peer.plan) fail('ed_reference_source_mismatch')
  const terms = validatedTerms(input.snapshot)
  const check = (field: string, entity: string, ref: string, inn?: string) => {
    const matches = keyNodes(message.objects, field, entity).filter(n => child(n, 'Ссылка')?.text.trim().toLowerCase() === ref.toLowerCase())
    if (!matches.length || inn && matches.some(n => child(n, 'ИНН')?.text.trim() !== inn)) fail('ed_reference_not_observed_' + field)
    return matches
  }
  const org = check('Организация', 'Справочник.Организации', input.references.organization, terms.seller!.inn)
  const buyer = check('Контрагент', 'Справочник.Контрагенты', input.references.counterparty, terms.buyer.inn)
  for (const [nodes, kpp, inn] of [[org, terms.seller!.kpp, terms.seller!.inn], [buyer, terms.buyer.kpp, terms.buyer.inn]] as const) {
    if (nodes.some(n => (child(n, 'КПП')?.text.trim() ?? '') !== (kpp ?? '') || child(n, 'ЮридическоеФизическоеЛицо')?.text.trim() !== (inn.length === 12 ? 'ФизическоеЛицо' : 'ЮридическоеЛицо'))) fail('ed_party_evidence_conflict')
  }
  if (terms.buyer.inn.length === 12 && buyer.some(n => !['true', '1'].includes(child(n, 'ИндивидуальныйПредприниматель')?.text.trim() ?? ''))) fail('ed_ip_evidence_required')
  check('Склад', 'Справочник.Склады', input.references.warehouse)
  for (const p of input.references.products) {
    check('Номенклатура', 'Справочник.Номенклатура', p.ref)
    let unitObserved = false
    const walk = (n: XmlNode) => {
      const data = child(n, 'ДанныеНоменклатуры', ED_NS), product = data && child(data, 'Номенклатура')
      const unit = child(n, 'ЕдиницаИзмерения', ED_NS), classifier = unit && child(unit, 'ДанныеКлассификатора')
      if (product && child(product, 'Ссылка')?.text.trim().toLowerCase() === p.ref.toLowerCase()
        && classifier && child(classifier, 'Код')?.text.trim() === p.unitCode && child(classifier, 'Наименование')?.text.trim() === p.unitName) unitObserved = true
      n.children.forEach(walk)
    }
    message.objects.forEach(walk)
    if (!unitObserved) fail('ed_product_unit_not_observed')
  }
  return terms
}
export function validatedTerms(value: unknown, testOnly = true): CommercialSnapshot {
  const identity = value as Partial<CommercialSnapshot> | null
  if (!identity?.orderId || !identity.storeId) return fail('ed_snapshot_required')
  const t = readCommercialSnapshot(value, { id: identity.orderId, storeId: identity.storeId })
  if (!t || !t.calculationPolicy || !t.seller || t.tax.mode === 'UNCONFIGURED' || t.currency !== 'RUB') return fail('ed_snapshot_invalid')
  if (t.tax.mode === 'GROSS_INCLUDED' && t.tax.rate !== 22) fail('ed_vat_rate_not_supported')
  if (testOnly && (!t.orderId.startsWith('ed-test:') || !t.number.startsWith('ED-TEST-'))) fail('ed_new_test_document_required')
  if (t.lines.some(l => Number(l.quantity) <= 0)) fail('ed_positive_quantity_required')
  if (!t.delivery.city.trim() || !t.delivery.address.trim()) fail('ed_delivery_address_required')
  return t
}
function party(ref: string, name: string, inn: string, kpp: string | null | undefined, buyer: boolean) {
  if (!/^\d{10}(\d{2})?$/.test(inn) || kpp && !/^\d{9}$/.test(kpp) || inn.length === 12 && kpp) fail('ed_party_requisites')
  return el('Ссылка', ref) + el('Наименование', name) + el('НаименованиеПолное', name) + el('ИНН', inn)
    + (kpp ? el('КПП', kpp) : '') + el('ЮридическоеФизическоеЛицо', inn.length === 12 ? 'ФизическоеЛицо' : 'ЮридическоеЛицо')
    + (buyer && inn.length === 12 ? el('ИндивидуальныйПредприниматель', 'true') : '')
}
/** Serializer only. Actual UT loading rules and partner selection still require acceptance. */
export function renderOrder(value: unknown, externalDocumentId: string) {
  const input = OrderInputSchema.parse(value), terms = validatedTerms(input.snapshot), refs = input.references
  return renderTerms(terms, refs, externalDocumentId, input.deliveryMethod, true)
}
export function renderWebsiteOrder(snapshot: unknown, references: Omit<OrderReferences, 'evidenceSha256'>, externalDocumentId: string, number: string, testEnvironment: boolean, assignment?: PartnerAssignment) {
  const terms = validatedTerms(snapshot, false)
  if (!/^[A-Z]{2}\d{9}$/.test(number)) fail('ed_order_number_invalid')
  const refs = ReferencesSchema.omit({ evidenceSha256: true }).parse(references)
  if (assignment && (!testEnvironment || assignment.documentId !== externalDocumentId || assignment.number !== number || assignment.counterpartyId !== refs.counterparty || assignment.organizationId !== refs.organization)) fail('ed_partner_assignment_mismatch')
  if (assignment && (terms.comment.includes(PARTNER_MARKER) || terms.delivery.name.includes(PARTNER_MARKER) || terms.number.includes(PARTNER_MARKER))) fail('ed_partner_marker_reserved')
  const originalNumber = terms.number
  return renderTerms({ ...terms, number, comment: 'AXIMA ' + originalNumber + '. Точка: ' + terms.delivery.name + '. Оплата: ' + (terms.channel.paymentMethod === 'BANK_TRANSFER' ? 'безналичная' : 'наличная') + '. ' + terms.comment }, refs, externalDocumentId, 'ДоКлиента', testEnvironment, assignment)
}
function renderTerms(terms: CommercialSnapshot, refs: Omit<OrderReferences, 'evidenceSha256'>, externalDocumentId: string, deliveryMethod: 'ДоКлиента' | 'Самовывоз', testEnvironment: boolean, assignment?: PartnerAssignment) {
  uuid.parse(externalDocumentId)
  if (terms.number.length > 256 || terms.lines.length > 1000) fail('ed_order_limit')
  if (new Set(refs.products.map(p => p.variantId)).size !== refs.products.length || refs.products.length !== new Set(terms.lines.map(l => l.variantId)).size) fail('ed_product_mapping_ambiguous')
  const taxes = saleLineTaxes(terms)
  const lines = terms.lines.map((line, index) => {
    const ref = refs.products.find(p => p.variantId === line.variantId) ?? fail('ed_product_mapping_missing')
    const tax = '<СтавкаНДС>' + (terms.tax.mode === 'GROSS_INCLUDED' ? el('Ставка', String(terms.tax.rate)) : '')
      + el('РасчетнаяСтавка', 'false') + el('НеОблагается', terms.tax.mode === 'NO_VAT' ? 'true' : 'false')
      + el('ВидСтавки', terms.tax.mode === 'NO_VAT' ? 'БезНДС' : 'Общая') + '</СтавкаНДС>'
    return '<Строка>' + el('НомерСтрокиДокумента', String(index + 1))
      + '<ДанныеНоменклатуры><Номенклатура>' + el('Ссылка', ref.ref) + el('Наименование', line.name) + '</Номенклатура></ДанныеНоменклатуры>'
      + '<ЕдиницаИзмерения><ДанныеКлассификатора>' + el('Код', ref.unitCode) + el('Наименование', ref.unitName) + '</ДанныеКлассификатора></ЕдиницаИзмерения>'
      + el('Количество', line.quantity) + el('Сумма', line.lineTotal) + el('Цена', line.unitPrice) + tax
      + (taxes ? el('СуммаНДС', taxes[index]) : '') + '</Строка>'
  }).join('')
  const comment = (assignment ? partnerAssignmentLine(assignment) + '\n' : '') + (testEnvironment ? 'ТЕСТ ENTERPRISEDATA — НЕ ОТГРУЖАТЬ, НЕ ОПЛАЧИВАТЬ, НЕ ДОСТАВЛЯТЬ. ' : '') + terms.comment
  return '<Документ.ЗаказКлиента><КлючевыеСвойства>' + el('Ссылка', externalDocumentId)
    + el('Дата', terms.acceptedAt) + el('Номер', terms.number) + '<Организация>'
    + party(refs.organization, terms.seller!.companyName, terms.seller!.inn, terms.seller!.kpp, false) + '</Организация></КлючевыеСвойства>'
    + el('СпособДоставки', deliveryMethod)
    + '<Валюта><ДанныеКлассификатора>' + el('Код', '643') + el('Наименование', 'Российский рубль') + '</ДанныеКлассификатора></Валюта>'
    + el('Сумма', terms.total) + '<Склад>' + el('Ссылка', refs.warehouse) + el('Наименование', terms.warehouse.name) + '</Склад>'
    + '<Контрагент>' + party(refs.counterparty, terms.buyer.legalName, terms.buyer.inn, terms.buyer.kpp, true) + '</Контрагент>'
    + el('АдресДоставки', terms.delivery.city.trim() + ', ' + terms.delivery.address.trim())
    + el('СуммаВключаетНДС', terms.tax.mode === 'GROSS_INCLUDED' ? 'true' : 'false') + '<Товары>' + lines + '</Товары>'
    + el('НалогообложениеНДСПродавца', terms.tax.mode === 'NO_VAT' ? 'НеОблагаетсяНДС' : 'ОблагаетсяНДС')
    + '<ОбщиеСвойстваОбъектовФормата>' + el('Комментарий', comment) + el('СостояниеОбъекта', 'Черновик')
    + '</ОбщиеСвойстваОбъектовФормата></Документ.ЗаказКлиента>'
}
export const requestDigest = (input: OrderInput) => digest(JSON.stringify(input))
