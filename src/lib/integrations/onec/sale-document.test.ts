import { describe, expect, it } from 'vitest'
import { SaxesParser } from 'saxes'
import { MONEY_POLICY } from '@/lib/money'
import type { CommercialSnapshot } from '@/lib/orders/commercial-snapshot'
import { saleLineTaxes, saleDocument, saleEnvelope, saleProfile, xmlText, type SaleReferences } from './sale-document'

const terms: CommercialSnapshot = {
  version: 1, calculationPolicy: MONEY_POLICY, orderId: 'order-1', storeId: 'store-1', number: 'R22-1',
  acceptedAt: '2026-09-21T22:30:00.000Z', connectionId: 'source-1',
  seller: { companyName: 'Тестовый продавец', inn: '7712345678', vatEnabled: true, vatRate: 22 },
  buyer: { id: 'buyer', legalName: 'Buyer & Co', inn: '7798765432', kpp: null },
  delivery: { id: 'delivery', name: 'Shop', city: 'Москва', address: 'Улица <Тест>' },
  warehouse: { id: 'warehouse', code: 'warehouse', name: 'Склад' },
  channel: { id: 'channel', code: 'bank', name: 'Банк', paymentMethod: 'BANK_TRANSFER' },
  pricing: { groupId: null, bookId: 'book', bookCode: 'base', bookName: 'Base' },
  tax: { mode: 'GROSS_INCLUDED', rate: 22, subtotal: '0.02', amount: '0.00' }, currency: 'RUB', total: '0.02', comment: 'Тест 😀',
  lines: ['a', 'b'].map(id => ({ id, productId: id, variantId: id, sku: id, sourceSku: null, name: 'Товар', packaging: 'шт',
    quantity: '0.1', unitPrice: '0.05', lineTotal: '0.01', listUnitPrice: '0.05', promotionIds: [] })),
}
const refs: SaleReferences = { customer: 'customer-external', seller: 'seller-external', warehouse: 'warehouse-external', priceType: 'price-external',
  warehouseAddress: { city: 'Тестовый город', address: 'Складская <улица>, 1' },
  products: ['a', 'b'].map(externalId => ({ externalId, unit: { code: '796', name: 'Штука' } })) }
const config = { saleExport: { enabled: true, format: 'COMMERCEML_2_10', currency: 'RUB', timeZone: 'Europe/Moscow' } }
const render = (value = terms) => saleDocument(value, refs, saleProfile(config))
describe('CommerceML sale document', () => {
  it('places the selected address under buyer Address/Representation while preserving the legal buyer and seller', () => {
    const xml = render()
    const parties = xml.match(/<Контрагент>[\s\S]*?<\/Контрагент>/g)!
    expect(parties[0]).toContain('<Наименование>Buyer &amp; Co</Наименование>')
    expect(parties[0]).toContain('<ИНН>7798765432</ИНН><Адрес><Представление>Москва, Улица &lt;Тест&gt;</Представление></Адрес><Роль>Покупатель</Роль>')
    expect(parties[0]).not.toContain('<ЮридическийАдрес>')
    expect(parties[0]).not.toContain('<АдресноеПоле>')
    expect(parties[1]).not.toContain('<Адрес>')
    const other = render({ ...terms, delivery: { ...terms.delivery, id: 'other', address: 'Другой филиал, 2' } })
    expect(other).toContain('<Представление>Москва, Другой филиал, 2</Представление>')
    expect(other).not.toContain('Улица &lt;Тест&gt;')
  })
  it('rejects an incomplete or overlong delivery address instead of truncating the destination', () => {
    expect(() => render({ ...terms, delivery: { ...terms.delivery, address: ' ' } })).toThrow('sale_delivery_address_required')
    expect(() => render({ ...terms, delivery: { ...terms.delivery, address: 'я'.repeat(256) } })).toThrow('sale_field_invalid')
  })
  it.each(['buyer', 'seller'] as const)('exports a 12-digit INN %s using individual/IP requisites', role => {
    const name = 'ИП Тестов & Партнёры'
    const value = role === 'buyer'
      ? { ...terms, buyer: { ...terms.buyer, legalName: name, inn: '262814584465', kpp: null } }
      : { ...terms, seller: { ...terms.seller!, companyName: name, inn: '262814584465' } }
    const xml = render(value)
    const parties = xml.match(/<Контрагент>[\s\S]*?<\/Контрагент>/g)!
    const ip = parties[role === 'buyer' ? 0 : 1]
    const company = parties[role === 'buyer' ? 1 : 0]
    expect(ip).toContain('<ПолноеНаименование>ИП Тестов &amp; Партнёры</ПолноеНаименование><ИНН>262814584465</ИНН>')
    expect(ip).not.toContain('<ОфициальноеНаименование>')
    expect(ip).not.toContain('<КПП>')
    expect(company).toContain('<ОфициальноеНаименование>')
    expect(company).not.toContain('<ПолноеНаименование>')
    new SaxesParser({ xmlns: true }).write(saleEnvelope([xml], new Date(0))).close()
  })
  it('preserves rounded fractional lines, escaped text and explicit timezone', () => {
    const xml = saleEnvelope([render()], new Date(terms.acceptedAt))
    const parser = new SaxesParser({ xmlns: true }); const values: string[] = []
    parser.on('error', e => { throw e }); parser.on('text', t => values.push(t)); parser.write(xml).close()
    expect(xml.match(/<Сумма>0.01<\/Сумма>/g)).toHaveLength(2)
    expect(xml).toContain('<Сумма>0.02</Сумма>')
    expect(xml).toContain('<Дата>2026-09-22</Дата><ХозОперация>'); expect(xml).toContain('<Время>01:30:00</Время>')
    expect(values).toContain('Buyer & Co'); expect(values).toContain('Тест 😀')
  })
  it('includes the warehouse address expected by UT without substituting buyer delivery', () => {
    const xml = render()
    expect(xml).toContain('<Адрес><Представление>Тестовый город, Складская &lt;улица&gt;, 1</Представление><АдресноеПоле><Тип>Город</Тип><Значение>Тестовый город</Значение></АдресноеПоле></Адрес>')
    const cityOnly = saleDocument(terms, { ...refs, warehouseAddress: { city: 'Евпатория' } }, saleProfile(config))
    expect(cityOnly).toContain('<Представление>Евпатория</Представление>')
    expect(cityOnly).toContain('<Тип>Город</Тип><Значение>Евпатория</Значение>')
    expect(xml.split('<Склады>')[1].split('</Склады>')[0]).not.toContain('Москва')
    expect(() => saleDocument(terms, { ...refs, warehouseAddress: undefined as never }, saleProfile(config))).toThrow('sale_warehouse_address_required')
  })
  it('provides the UT warehouse contact path without fabricating a phone', () => {
    const xml = saleEnvelope([render()], new Date(terms.acceptedAt))
    const parser = new SaxesParser({ xmlns: true })
    const path: string[] = []; let contactValues = 0; let contactText = ''
    const valuePath = 'КоммерческаяИнформация/Документ/Склады/Склад/Контакты/Контакт/Значение'
    parser.on('opentag', tag => { path.push(tag.local); if (path.join('/') === valuePath) contactValues++ })
    parser.on('text', text => { if (path.join('/') === valuePath) contactText += text })
    parser.on('closetag', () => { path.pop() })
    parser.write(xml).close()
    expect(contactValues).toBe(1)
    expect(contactText).toBe('')
    expect(xml).toContain('</Адрес><Контакты><Контакт><Тип>Телефон рабочий</Тип><Значение></Значение></Контакт></Контакты></Склад>')
  })
  it('emits a valid empty envelope', () => {
    expect(saleEnvelope([], new Date(0))).not.toContain('<Документ>')
    new SaxesParser().write(saleEnvelope([], new Date(0))).close()
  })
  it.each(['\u0000', '\u0001', '\uD800', '\uFFFE'])('rejects invalid XML character %j without deleting it', value => {
    expect(() => xmlText(value)).toThrow('sale_invalid_xml_character')
  })
  it('requires an enabled explicit supported dialect and valid timezone', () => {
    expect(() => saleProfile({})).toThrow('sale_export_not_configured')
    expect(() => saleProfile({ saleExport: { ...config.saleExport, format: 'unknown' } })).toThrow('sale_export_not_configured')
    expect(() => saleProfile({ saleExport: { ...config.saleExport, timeZone: 'Unknown/Zone' } })).toThrow('sale_timezone_invalid')
  })
  it('blocks foreign currency, missing/currently invalid snapshot and unsourced product identity', () => {
    expect(() => render({ ...terms, currency: 'USD' })).toThrow('sale_currency_unsupported')
    expect(() => render({ ...terms, calculationPolicy: undefined })).toThrow('sale_snapshot_policy_required')
    expect(() => render({ ...terms, total: '0.03' })).toThrow('sale_snapshot_policy_required')
    expect(() => saleDocument(terms, { ...refs, products: [] }, saleProfile(config))).toThrow('sale_product_mapping_required')
  })
  it('represents NO_VAT without inventing zero-rate VAT', () => {
    const xml = render({ ...terms, seller: { ...terms.seller!, vatEnabled: false }, tax: { mode: 'NO_VAT', rate: null, subtotal: '0.02', amount: '0.00' } })
    expect(xml).not.toContain('<Налоги>'); expect(xml).toContain('Без НДС')
  })
  it('rejects overlong identity and invalid requisites instead of truncating', () => {
    expect(() => render({ ...terms, number: 'x'.repeat(21) })).toThrow('sale_field_invalid')
    expect(() => render({ ...terms, buyer: { ...terms.buyer, inn: 'unknown' } })).toThrow('sale_party_requisites_invalid')
  })
})


describe('line VAT export', () => {
  const taxable = (values: string[], total: string, vat: string, subtotal: string): CommercialSnapshot => ({ ...terms,
    total, tax: {mode: 'GROSS_INCLUDED', rate: 22, subtotal, amount: vat},
    lines: values.map((value, i) => ({...terms.lines[0], id: String(i), quantity: '1', unitPrice: value, lineTotal: value, listUnitPrice: value})) })
  it('exports included 22% and 48.69 VAT on the actual 270-ruble line', () => {
    const t = taxable(['270.00'], '270.00', '48.69', '221.31')
    const xml = saleDocument(t, {...refs, products: refs.products.slice(0, 1)}, saleProfile(config))
    const line = xml.split('<Товары>')[1].split('</Товары>')[0]
    expect(line).toContain('<СтавкиНалогов><СтавкаНалога><Наименование>НДС</Наименование><Ставка>22</Ставка>')
    expect(line).toContain('<УчтеноВСумме>true</УчтеноВСумме><Сумма>48.69</Сумма>')
    expect(line).toContain('<ЦенаЗаЕдиницу>270.00</ЦенаЗаЕдиницу>')
  })
  it('preserves total VAT on penny ties and different remainders', () => {
    expect(saleLineTaxes(taxable(['0.03', '0.03'], '0.06', '0.01', '0.05'))).toEqual(['0.01', '0.00'])
    expect(saleLineTaxes(taxable(['0.01', '0.04'], '0.05', '0.01', '0.04'))).toEqual(['0.00', '0.01'])
    expect(saleLineTaxes(taxable(['270.00', '122.00'], '392.00', '70.69', '321.31'))).toEqual(['48.69', '22.00'])
    expect(saleLineTaxes(taxable(['9999999999999999.99'], '9999999999999999.99', '1803278688524590.16', '8196721311475409.83'))).toEqual(['1803278688524590.16'])
  })
})
