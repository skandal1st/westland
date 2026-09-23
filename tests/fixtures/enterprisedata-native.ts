import { fixture, now } from './enterprisedata'
import { element as el } from '../../src/lib/integrations/enterprisedata/message'
import { nativeEvidenceDigest } from '../../src/lib/integrations/enterprisedata/native-evidence'
import type { CommercialSnapshot } from '../../src/lib/orders/commercial-snapshot'
export function nativeFixture() {
  const { input } = fixture(), t = input.snapshot as CommercialSnapshot, r = input.references
  const oldId = '77777777-7777-4777-8777-777777777777', partner = '88888888-8888-4888-8888-888888888888'
  const unit = '99999999-9999-4999-8999-999999999999', vat = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const doc = (name: string, ref: string, body: string) => Buffer.from('<' + name + '>' + el('Ref', ref) + el('DeletionMark', 'false') + body + '</' + name + '>')
  const party = (inn: string, kpp: string | undefined | null, name: string) => el('ИНН', inn) + el('КПП', kpp ?? '') + el('НаименованиеПолное', name)
  const evidence = {
    order: doc('DocumentObject.ЗаказКлиента', oldId, el('Контрагент', r.counterparty) + el('Организация', r.organization) + el('Склад', r.warehouse) + el('Партнер', partner) + el('СуммаДокумента', t.total) + '<Товары><Row>' + el('Номенклатура', r.products[0].ref) + el('Количество', '1') + el('Цена', '270') + el('СтавкаНДС', vat) + '</Row></Товары>'),
    counterparty: doc('CatalogObject.Контрагенты', r.counterparty, party(t.buyer.inn, t.buyer.kpp, t.buyer.legalName) + el('Партнер', partner) + el('ЮрФизЛицо', 'ИндивидуальныйПредприниматель')),
    organization: doc('CatalogObject.Организации', r.organization, party(t.seller!.inn, t.seller!.kpp, t.seller!.companyName)),
    product: doc('CatalogObject.Номенклатура', r.products[0].ref, el('НаименованиеПолное', t.lines[0].name) + el('IsFolder', 'false') + el('ИспользованиеХарактеристик', 'НеИспользовать') + el('ИспользоватьУпаковки', 'false') + el('ЕдиницаИзмерения', unit) + el('СтавкаНДС', vat)),
    confirmation: Buffer.from(JSON.stringify({ source: 'synthetic user confirmation', confirmedAt: now, vatRate: 22, unitDisplay: 'шт', unitCodeSource: 'synthetic unit mapping 796', nativeUnitRef: unit, nativeVatRef: vat })),
  }
  input.references.evidenceSha256 = nativeEvidenceDigest(evidence)
  return { input, evidence, oldId }
}
