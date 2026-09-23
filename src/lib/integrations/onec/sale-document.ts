import { z } from 'zod'
import { decimal } from '@/lib/money'
import { WarehouseAddressSchema } from '../warehouse-address'
import { readCommercialSnapshot, type CommercialSnapshot } from '@/lib/orders/commercial-snapshot'
import { ExchangeError } from './storage'

export const SaleProfileSchema = z.object({
  enabled: z.literal(true), format: z.literal('COMMERCEML_2_10'),
  currency: z.literal('RUB'), timeZone: z.string().min(1),
}).strict()
export const SaleUnitSchema = z.object({ code: z.string().regex(/^\d{3}$/), name: z.string().min(1).max(255) })
export type SaleReferences = {
  customer: string; seller: string; warehouse: string; priceType: string
  warehouseAddress: z.infer<typeof WarehouseAddressSchema>
  products: Array<{ externalId: string; unit: z.infer<typeof SaleUnitSchema> }>
}
export function saleProfile(config: unknown) {
  const parsed = SaleProfileSchema.safeParse((config as { saleExport?: unknown } | null)?.saleExport)
  if (!parsed.success) throw new ExchangeError('sale_export_not_configured', 503)
  try { new Intl.DateTimeFormat('en', { timeZone: parsed.data.timeZone }).format() }
  catch { throw new ExchangeError('sale_timezone_invalid') }
  return parsed.data
}
export function xmlText(value: string): string {
  for (const char of Array.from(value)) {
    const code = char.codePointAt(0)!
    if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xD7FF) || (code >= 0xE000 && code <= 0xFFFD) || (code >= 0x10000 && code <= 0x10FFFF))) throw new ExchangeError('sale_invalid_xml_character')
  }
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
const el = (tag: string, value: string) => `<${tag}>${xmlText(value)}</${tag}>`
const bounded = (value: string, max: number) => {
  if (!value.trim() || Array.from(value).length > max) throw new ExchangeError('sale_field_invalid')
  return value
}
const requisite = (name: string, value: string) => '<ЗначениеРеквизита>' + el('Наименование', name) + el('Значение', value) + '</ЗначениеРеквизита>'
function party(id: string, name: string, inn: string, kpp: string | null | undefined, role: string, deliveryAddress?: string) {
  if (!/^\d{10}(\d{2})?$/.test(inn) || (kpp && !/^\d{9}$/.test(kpp))) throw new ExchangeError('sale_party_requisites_invalid')
  return '<Контрагент>' + el('Ид', bounded(id, 40)) + el('Наименование', bounded(name, 255))
    // CommerceML distinguishes legal entities from individuals/IP by the name tag.
    // UT uses that distinction when looking up an existing counterparty by INN.
    + el(inn.length === 12 ? 'ПолноеНаименование' : 'ОфициальноеНаименование', name) + el('ИНН', inn)
    + (kpp ? el('КПП', kpp) : '')
    + (deliveryAddress ? '<Адрес>' + el('Представление', deliveryAddress) + '</Адрес>' : '') + el('Роль', role) + '</Контрагент>'
}
/** Allocate the snapshot's total VAT in cents, using largest remainders and stable line order.
 * This preserves the accepted R21 gross-total policy even when rounding each line differs. */
export function saleLineTaxes(terms: CommercialSnapshot): string[] {
  if (terms.tax.mode !== 'GROSS_INCLUDED') return terms.lines.map(() => '0.00')
  const rate = decimal(terms.tax.rate!)
  const exact = terms.lines.map(line => decimal(line.lineTotal).mul(rate).div(rate.add(100)).mul(100))
  const cents = exact.map(value => value.floor())
  const remaining = decimal(terms.tax.amount!).mul(100).sub(cents.reduce((sum, value) => sum.add(value), decimal(0))).toNumber()
  if (!Number.isInteger(remaining) || remaining < 0 || remaining > cents.length) throw new ExchangeError('sale_tax_allocation_invalid')
  const ranked = exact.map((value, index) => ({ index, remainder: value.sub(cents[index]) }))
    .sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index)
  for (const { index } of ranked.slice(0, remaining)) cents[index] = cents[index].add(1)
  return cents.map(value => value.div(100).toFixed(2))
}
/** One supported, explicit dialect. No guessed SKU/GUID, OKEI, exchange rate or tax. */
export function saleDocument(terms: CommercialSnapshot, refs: SaleReferences, profile: ReturnType<typeof saleProfile>): string {
  if (!readCommercialSnapshot(terms, { id: terms.orderId, storeId: terms.storeId }) || !terms.calculationPolicy) throw new ExchangeError('sale_snapshot_policy_required')
  if (terms.currency !== profile.currency) throw new ExchangeError('sale_currency_unsupported')
  if (!terms.seller || terms.tax.mode === 'UNCONFIGURED') throw new ExchangeError('sale_seller_required')
  if (refs.products.length !== terms.lines.length) throw new ExchangeError('sale_product_mapping_required')
  const address = WarehouseAddressSchema.safeParse(refs.warehouseAddress)
  if (!address.success) throw new ExchangeError('sale_warehouse_address_required')
  // The observed UT importer reads this field directly, although XSD makes it optional.
  const warehouseAddress = '<Адрес>' + el('Представление', [address.data.city, address.data.address].filter(Boolean).join(', '))
    + '<АдресноеПоле>' + el('Тип', 'Город') + el('Значение', address.data.city) + '</АдресноеПоле></Адрес>'
  // The observed UT importer dereferences Contacts.Contact.Value even without a phone.
  // Keep the XSD-valid value empty; never invent contact information.
  const warehouseContacts = '<Контакты><Контакт>' + el('Тип', 'Телефон рабочий') + el('Значение', '') + '</Контакт></Контакты>'
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: profile.timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(terms.acceptedAt))
  const part = (type: string) => parts.find(p => p.type === type)!.value
  const date = `${part('year')}-${part('month')}-${part('day')}`, time = `${part('hour')}:${part('minute')}:${part('second')}`
  // UT reads the buyer's Address/Representation into the order delivery address.
  // Omit structured fields: a partial city-only list can discard the free-text street.
  // This is the selected delivery address, never a legal/registration address.
  const deliveryAddress = bounded(terms.delivery.city.trim() + ', ' + terms.delivery.address.trim(), 255)
  if (!terms.delivery.city.trim() || !terms.delivery.address.trim()) throw new ExchangeError('sale_delivery_address_required')
  const lineTaxes = saleLineTaxes(terms)
  const lines = terms.lines.map((line, i) => {
    const ref = refs.products[i], unit = SaleUnitSchema.parse(ref.unit)
    return '<Товар>' + el('Ид', bounded(ref.externalId, 80)) + el('Наименование', bounded(line.name, 255))
      + `<БазоваяЕдиница Код="${xmlText(unit.code)}" НаименованиеПолное="${xmlText(unit.name)}"/>`
      + (terms.tax.mode === 'GROSS_INCLUDED' ? '<СтавкиНалогов><СтавкаНалога>' + el('Наименование', 'НДС') + el('Ставка', String(terms.tax.rate)) + '</СтавкаНалога></СтавкиНалогов>' : '')
      + el('ЦенаЗаЕдиницу', line.unitPrice) + el('Количество', line.quantity) + el('Сумма', line.lineTotal)
      + el('Единица', unit.code) + el('Коэффициент', '1')
      + (terms.tax.mode === 'GROSS_INCLUDED' ? '<Налоги><Налог>' + el('Наименование', 'НДС') + el('УчтеноВСумме', 'true') + el('Сумма', lineTaxes[i]) + el('Ставка', String(terms.tax.rate)) + '</Налог></Налоги>' : '') + '</Товар>'
  }).join('')
  return '<Документ>' + el('Ид', bounded(terms.orderId, 40)) + el('Номер', bounded(terms.number, 20))
    + el('Дата', date) + el('ХозОперация', 'Заказ товара') + el('Роль', 'Продавец')
    + el('Валюта', terms.currency) + el('Курс', '1') + el('Сумма', terms.total)
    + '<Контрагенты>' + party(refs.customer, terms.buyer.legalName, terms.buyer.inn, terms.buyer.kpp, 'Покупатель', deliveryAddress)
    + party(refs.seller, terms.seller.companyName, terms.seller.inn, terms.seller.kpp, 'Продавец') + '</Контрагенты>'
    + el('Время', time) + el('Комментарий', terms.comment.length <= 3000 ? terms.comment : bounded(terms.comment, 3000))
    + (terms.tax.mode === 'GROSS_INCLUDED' ? '<Налоги><Налог>' + el('Наименование', 'НДС') + el('УчтеноВСумме', 'true') + el('Сумма', terms.tax.amount!) + el('Ставка', String(terms.tax.rate)) + '</Налог></Налоги>' : '')
    + '<Склады><Склад>' + el('Ид', bounded(refs.warehouse, 40)) + el('Наименование', bounded(terms.warehouse.name, 255)) + warehouseAddress + warehouseContacts + '</Склад></Склады>'
    + '<Товары>' + lines + '</Товары><ЗначенияРеквизитов>'
    + requisite('Метод оплаты', terms.channel.paymentMethod === 'BANK_TRANSFER' ? 'Безналичный расчет' : 'Наличный расчет')
    + requisite('Адрес доставки', deliveryAddress)
    + requisite('Ид типа цены', bounded(refs.priceType, 40))
    + requisite('Канал оформления', terms.channel.code)
    + requisite('Налогообложение', terms.tax.mode === 'NO_VAT' ? 'Без НДС' : 'НДС включен в сумму')
    + '</ЗначенияРеквизитов></Документ>'
}
export function saleEnvelope(documents: string[], at: Date): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<КоммерческаяИнформация xmlns="urn:1C.ru:commerceml_2" ВерсияСхемы="2.10" ДатаФормирования="' + at.toISOString() + '">' + documents.join('') + '</КоммерческаяИнформация>\n'
}
