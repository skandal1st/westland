import { describe, expect, it } from 'vitest'
import { parseCatalog, parseOffers, topLevelCategoryId, type OnecOffer, type OnecRawProduct } from './commerceml'

const OFFERS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.07">
 <ИзмененияПакетаПредложений>
  <Ид>pkg</Ид>
  <Предложения>
   <Предложение>
    <Ид>t1</Ид>
    <Склады ИдСклада="WA" КоличествоНаСкладе="5"/>
    <Склады ИдСклада="WB" КоличествоНаСкладе="0"/>
    <Цены><Цена><ИдТипаЦены>PT</ИдТипаЦены><ЦенаЗаЕдиницу>590</ЦенаЗаЕдиницу><Валюта>RUB</Валюта></Цена></Цены>
    <Количество>5</Количество>
   </Предложение>
   <Предложение>
    <Ид>t2</Ид>
    <Склады ИдСклада="WA" КоличествоНаСкладе="0"/>
    <Цены><Цена><ИдТипаЦены>PT</ИдТипаЦены><ЦенаЗаЕдиницу>0</ЦенаЗаЕдиницу><Валюта>RUB</Валюта></Цена></Цены>
    <Количество>0</Количество>
   </Предложение>
  </Предложения>
 </ИзмененияПакетаПредложений>
</КоммерческаяИнформация>`

describe('CommerceML offers parser', () => {
  it('parses price, currency, price type, qty and per-warehouse stock', () => {
    const offers: OnecOffer[] = []
    const { offerCount } = parseOffers(OFFERS_XML, (o) => offers.push(o))
    expect(offerCount).toBe(2)

    const t1 = offers.find((o) => o.externalId === 't1')!
    expect(t1.prices).toEqual([{ amount: 590, currency: 'RUB', priceTypeId: 'PT' }])
    expect(t1.qty).toBe(5)
    expect(t1.warehouses).toEqual([{ id: 'WA', qty: 5 }, { id: 'WB', qty: 0 }])

    const t2 = offers.find((o) => o.externalId === 't2')!
    expect(t2.prices[0].amount).toBe(0)
  })
})

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<КоммерческаяИнформация ВерсияСхемы="2.07">
 <Классификатор>
  <Ид>cls</Ид>
  <Наименование>Каталог</Наименование>
  <Владелец><Ид>owner</Ид><Наименование>ИП Мартовой</Наименование><ИНН>910703005363</ИНН></Владелец>
  <Группы>
   <Группа>
    <Ид>g-tabak</Ид><Наименование>Табак</Наименование>
    <Группы>
     <Группа>
      <Ид>g-burn</Ид><Наименование>BURN</Наименование>
      <Группы><Группа><Ид>g-black</Ид><Наименование>BlackBurn</Наименование></Группа></Группы>
     </Группа>
    </Группы>
   </Группа>
   <Группа><Ид>g-kalyan</Ид><Наименование>Кальяны</Наименование></Группа>
  </Группы>
  <Свойства><Свойство><Ид>p1</Ид><Наименование>Вкус</Наименование></Свойство></Свойства>
 </Классификатор>
 <Каталог>
  <Ид>cat</Ид>
  <Товары>
   <Товар>
    <Ид>t1</Ид><Штрихкод>4600</Штрихкод><Артикул/>
    <Наименование>Табак BlackBurn 200</Наименование>
    <БазоваяЕдиница Код="796" НаименованиеПолное="Штука"/>
    <Группы><Ид>g-black</Ид></Группы>
    <ЗначенияРеквизитов>
     <ЗначениеРеквизита><Наименование>Код</Наименование><Значение>УТ-001</Значение></ЗначениеРеквизита>
    </ЗначенияРеквизитов>
   </Товар>
   <Товар>
    <Ид>t2</Ид><Штрихкод></Штрихкод><Артикул>ART-2</Артикул>
    <Наименование>Кальян X</Наименование>
    <Группы><Ид>g-kalyan</Ид></Группы>
   </Товар>
   <Товар>
    <Ид>t3</Ид><Артикул/><Наименование>Без штрихкода</Наименование>
    <Группы><Ид>g-kalyan</Ид></Группы>
    <ЗначенияРеквизитов>
     <ЗначениеРеквизита><Наименование>Код</Наименование><Значение>УТ-003</Значение></ЗначениеРеквизита>
    </ЗначенияРеквизитов>
   </Товар>
  </Товары>
 </Каталог>
</КоммерческаяИнформация>`

describe('CommerceML catalog parser', () => {
  it('builds the nested group tree, ignoring owner/properties', () => {
    const { groups } = parseCatalog(XML, () => {})
    expect(groups.size).toBe(4)
    expect(groups.get('g-tabak')?.parentId).toBeNull()
    expect(groups.get('g-burn')?.parentId).toBe('g-tabak')
    expect(groups.get('g-black')?.parentId).toBe('g-burn')
    expect(groups.get('g-kalyan')?.name).toBe('Кальяны')
  })

  it('resolves the top-level category from a deep group', () => {
    const { groups } = parseCatalog(XML, () => {})
    expect(topLevelCategoryId('g-black', groups)).toBe('g-tabak')
    expect(topLevelCategoryId('g-kalyan', groups)).toBe('g-kalyan')
    expect(topLevelCategoryId('unknown', groups)).toBe('unknown')
  })

  it('emits products with SKU fallback (Артикул → Штрихкод → Код) and top-level category', () => {
    const products: OnecRawProduct[] = []
    const { productCount } = parseCatalog(XML, (p) => products.push(p))
    expect(productCount).toBe(3)

    const t1 = products.find((p) => p.externalId === 't1')!
    expect(t1.sku).toBe('4600') // empty Артикул → Штрихкод
    expect(t1.name).toBe('Табак BlackBurn 200')
    expect(t1.categoryExternalId).toBe('g-tabak')
    expect(t1.barcode).toBe('4600')
    expect(t1.packaging).toBe('Штука')
    expect(t1.baseUnit).toEqual({ code: '796', name: 'Штука' })
    expect(t1.groupId).toBe('g-black')

    const t2 = products.find((p) => p.externalId === 't2')!
    expect(t2.sku).toBe('ART-2') // Артикул present
    expect(t2.categoryExternalId).toBe('g-kalyan')

    const t3 = products.find((p) => p.externalId === 't3')!
    expect(t3.sku).toBe('УТ-003') // empty Артикул, no Штрихкод → Код
  })
})
