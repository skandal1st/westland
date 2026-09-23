import { expect, it } from 'vitest'
import { parseExchangeMetadata, mergeMetadata } from './metadata'
import { parseCatalog, parseOffers } from './commerceml'
it('reads explicit full, delta and unknown conservatively', () => {
  for (const [flag, mode] of [['false', 'full'], ['true', 'delta'], ['', 'unknown']]) expect(parseExchangeMetadata(`<КоммерческаяИнформация><Каталог ${flag ? `СодержитТолькоИзменения="${flag}"` : ''}/></КоммерческаяИнформация>`, 'catalog').mode).toBe(mode)
  expect(parseExchangeMetadata('<КоммерческаяИнформация><ИзмененияПакетаПредложений/></КоммерческаяИнформация>', 'offers').mode).toBe('delta')
})
it('does not coerce malformed quantities to zero', () => {
  for (const value of ['oops', '', 'NaN', 'Infinity', '-Infinity', '1e309', '1 2']) expect(() => parseOffers(`<Предложение><Ид>p</Ид><Склады ИдСклада="w" КоличествоНаСкладе="${value}"/></Предложение>`, () => {})).toThrow('invalid_offer_number')
})
it('missing currency never borrows it from another price row', () => {
  parseOffers('<Предложение><Ид>p</Ид><Цены><Цена><ИдТипаЦены>a</ИдТипаЦены><ЦенаЗаЕдиницу>1</ЦенаЗаЕдиницу></Цена><Цена><ИдТипаЦены>b</ИдТипаЦены><ЦенаЗаЕдиницу>2</ЦенаЗаЕдиницу><Валюта>USD</Валюта></Цена></Цены></Предложение>', row => expect(row.prices).toEqual([{ priceTypeId: 'a', amount: 1, currency: '' }, { priceTypeId: 'b', amount: 2, currency: 'USD' }]))
})
it('rejects inconsistent parts before any import', () => {
  const a = parseExchangeMetadata('<КоммерческаяИнформация><Каталог СодержитТолькоИзменения="false"/></КоммерческаяИнформация>', 'catalog')
  expect(() => mergeMetadata([a, { ...a, mode: 'delta' }])).toThrow('inconsistent_exchange_parts')
})
it('keeps id-only tombstones and refuses silently dropped live records', () => {
  parseCatalog('<Каталог><Товары><Товар Статус="Удален"><Ид>p</Ид></Товар></Товары></Каталог>', row => expect(row).toMatchObject({ externalId: 'p', deleted: true }))
  expect(() => parseCatalog('<Каталог><Товары><Товар><Ид>p</Ид></Товар></Товары></Каталог>', () => {})).toThrow('invalid_catalog_product')
})

it('preserves signed warehouse and total quantities without relaxing prices', () => {
  parseOffers('<Предложение><Ид>p</Ид><Количество>-9,125</Количество><Склад ИдСклада="a" КоличествоНаСкладе="-1,2"/><Склады ИдСклада="b" КоличествоНаСкладе="3"/><Цены><Цена><ИдТипаЦены>pt</ИдТипаЦены><ЦенаЗаЕдиницу>12.34</ЦенаЗаЕдиницу><Валюта>RUB</Валюта></Цена></Цены></Предложение>', row => {
    expect(row.qty).toBe(-9.125)
    expect(row.warehouses).toEqual([{ id: 'a', qty: -1.2 }, { id: 'b', qty: 3 }])
    expect(row.prices[0].amount).toBe(12.34)
  })
  for (const value of ['-1', '-0.001', 'NaN', 'Infinity']) expect(() => parseOffers(`<Предложение><Ид>p</Ид><Цены><Цена><ЦенаЗаЕдиницу>${value}</ЦенаЗаЕдиницу></Цена></Цены></Предложение>`, () => {})).toThrow('invalid_offer_number')
})
