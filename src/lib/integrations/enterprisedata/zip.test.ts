import { describe, expect, it } from 'vitest'
import fixtures from '../../../../tests/fixtures/enterprisedata-zip.json'
import { readXmlZip, writeXmlZip } from './zip'

describe('bounded single-file ZIP transport', () => {
  it.each(['deflated', 'descriptor'] as const)('reads independently generated Python ZIP: %s', key => {
    expect(readXmlZip(Buffer.from(fixtures[key], 'base64')).toString()).toBe('<test>independent Python zipfile</test>')
  })
  it.each(['multiple', 'traversal', 'expansion'] as const)('rejects %s', key => {
    expect(() => readXmlZip(Buffer.from(fixtures[key], 'base64'))).toThrow('ed_zip_invalid_or_unsupported')
  })
  it('writes deterministic stored archives and rejects CRC damage and trailing data', () => {
    const xml = Buffer.from('<Message>тест</Message>'), zip = writeXmlZip(xml)
    expect(zip).toEqual(writeXmlZip(xml)); expect(readXmlZip(zip)).toEqual(xml)
    const corrupt = Buffer.from(zip); corrupt[41] ^= 1
    expect(() => readXmlZip(corrupt)).toThrow('ed_zip_invalid_or_unsupported')
    expect(() => readXmlZip(Buffer.concat([zip, Buffer.from('extra')]))).toThrow('ed_zip_invalid_or_unsupported')
  })
})
