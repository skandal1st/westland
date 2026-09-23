import { expect, it } from 'vitest'
import { inspectSaleXml } from './sale-inbox'
const wrap = (content = '<Документ><Ид>site-order</Ид></Документ>') => '<КоммерческаяИнформация xmlns="urn:1C.ru:commerceml_2" ВерсияСхемы="2.10">' + content + '</КоммерческаяИнформация>'
it('accepts complete UTF8 XML and containers without interpreting a decision', () => {
  expect(inspectSaleXml(Buffer.from(wrap())).documentCount).toBe(1)
  expect(inspectSaleXml(Buffer.from(wrap('<Контейнер><Документ><Ид>1</Ид></Документ></Контейнер>'))).documentCount).toBe(1)
  expect(inspectSaleXml(Buffer.from('\ufeff' + wrap())).xml).toBe('\ufeff' + wrap())
})
it.each([
  '<!DOCTYPE x [<!ENTITY v SYSTEM "file:///etc/passwd">]>' + wrap(),
  '<КоммерческаяИнформация>', '<xml/>', wrap('<Каталог/>'),
  wrap('<Документ xmlns="urn:foreign"/>'), wrap('<Документ><Документ/></Документ>'),
  wrap('<Документ/>'.repeat(1001)),
  wrap('<Документ>' + '<x>'.repeat(33) + '</x>'.repeat(33) + '</Документ>'),
  '<?xml version="1.0" encoding="windows-1251"?>' + wrap(),
])('rejects unsupported or unsafe framing', xml => { expect(() => inspectSaleXml(Buffer.from(xml))).toThrow() })
it('rejects invalid UTF8 rather than replacing bytes', () => { expect(() => inspectSaleXml(Buffer.from([0xff]))).toThrow('sale_utf8_required') })
