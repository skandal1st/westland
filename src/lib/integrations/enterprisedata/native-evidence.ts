import { z } from 'zod'
import { child, digest, fail, parseXml, scalar, type XmlNode } from './message'
import { type OrderInput, validatedTerms } from './order'
import { money } from '@/lib/money'
export type NativeEvidence = { order: Buffer; counterparty: Buffer; organization: Buffer; product: Buffer; confirmation: Buffer }
const names = ['order', 'counterparty', 'organization', 'product', 'confirmation'] as const
const files = ['order.xml', 'counterparty.xml', 'organization.xml', 'product.xml', 'user-confirmation.json']
export function nativeEvidenceDigest(evidence: NativeEvidence) {
  return digest(JSON.stringify(Object.fromEntries(names.map((key, i) => [files[i], digest(evidence[key])]))))
}
/** User-provided native references are a separate provenance path, never an ED receipt. */
export function validateNativeReferences(input: OrderInput, evidence: NativeEvidence) {
  const terms = validatedTerms(input.snapshot), refs = input.references
  const sourceDigest = nativeEvidenceDigest(evidence)
  if (sourceDigest !== refs.evidenceSha256) fail('ed_native_evidence_mismatch')
  const root = (bytes: Buffer, name: string) => {
    const n = parseXml(bytes)
    if (n.name !== name || scalar(n, 'DeletionMark') !== 'false') fail('ed_native_object_invalid')
    z.string().uuid().parse(scalar(n, 'Ref'))
    return n
  }
  const order = root(evidence.order, 'DocumentObject.ЗаказКлиента')
  const buyer = root(evidence.counterparty, 'CatalogObject.Контрагенты')
  const seller = root(evidence.organization, 'CatalogObject.Организации')
  const product = root(evidence.product, 'CatalogObject.Номенклатура')
  const same = (actual: string, expected: string) => { if (actual !== expected) fail('ed_native_reference_conflict') }
  const party = (n: XmlNode, field: string, ref: string, inn: string, kpp: string | null | undefined, name: string) => {
    same(scalar(n, 'Ref'), ref); same(scalar(order, field), ref)
    same(scalar(n, 'ИНН'), inn); same(scalar(n, 'КПП'), kpp ?? '')
    same(scalar(n, 'НаименованиеПолное'), name)
  }
  party(buyer, 'Контрагент', refs.counterparty, terms.buyer.inn, terms.buyer.kpp, terms.buyer.legalName)
  party(seller, 'Организация', refs.organization, terms.seller!.inn, terms.seller!.kpp, terms.seller!.companyName)
  same(scalar(order, 'Склад'), refs.warehouse)
  same(scalar(order, 'Партнер'), scalar(buyer, 'Партнер'))
  if (terms.buyer.inn.length !== 12 || scalar(buyer, 'ЮрФизЛицо') !== 'ИндивидуальныйПредприниматель') fail('ed_native_ip_required')
  const rows = child(order, 'Товары')?.children ?? []
  if (rows.length !== 1 || rows[0].name !== 'Row' || terms.lines.length !== 1 || refs.products.length !== 1) fail('ed_native_single_line_required')
  const row = rows[0], line = terms.lines[0], ref = refs.products[0]
  if (!line.variantId) return fail('ed_native_variant_required')
  same(ref.variantId, line.variantId); same(scalar(product, 'Ref'), ref.ref); same(scalar(row, 'Номенклатура'), ref.ref)
  same(scalar(product, 'НаименованиеПолное'), line.name)
  if (scalar(product, 'IsFolder') !== 'false' || scalar(product, 'ИспользованиеХарактеристик') !== 'НеИспользовать' || scalar(product, 'ИспользоватьУпаковки') !== 'false') fail('ed_native_product_unsupported')
  same(money(scalar(row, 'Цена')), line.unitPrice); same(money(scalar(order, 'СуммаДокумента')), terms.total)
  if (Number(scalar(row, 'Количество')) !== Number(line.quantity)) fail('ed_native_quantity_conflict')
  const confirmation = z.object({ source: z.string().min(1), confirmedAt: z.string().datetime(), vatRate: z.literal(22), unitDisplay: z.literal('шт'), unitCodeSource: z.string().min(1), nativeUnitRef: z.string().uuid(), nativeVatRef: z.string().uuid() }).parse(JSON.parse(evidence.confirmation.toString('utf8')))
  same(scalar(product, 'ЕдиницаИзмерения'), confirmation.nativeUnitRef)
  same(scalar(product, 'СтавкаНДС'), confirmation.nativeVatRef); same(scalar(row, 'СтавкаНДС'), confirmation.nativeVatRef)
  if (terms.tax.mode !== 'GROSS_INCLUDED' || terms.tax.rate !== 22 || ref.unitCode !== '796' || !['шт', 'Штука'].includes(ref.unitName)) fail('ed_native_tax_unit_conflict')
  return { terms, sourceDigest, originalDocumentId: scalar(order, 'Ref'), sourcePartner: scalar(buyer, 'Партнер'), provenance: 'user-supplied-native' as const }
}
