import { describe, expect, it } from 'vitest'
import {
  checkCredentials,
  emptySaleDocument,
  mintSession,
  parseBasicAuth,
  readCookie,
  safeFilename,
  verifySession,
} from './exchange'

describe('1C exchange transport helpers', () => {
  it('parses Basic auth and tolerates passwords containing colons', () => {
    const header = 'Basic ' + Buffer.from('exchange:pa:ss', 'utf8').toString('base64')
    expect(parseBasicAuth(header)).toEqual({ user: 'exchange', pass: 'pa:ss' })
    expect(parseBasicAuth(null)).toBeNull()
    expect(parseBasicAuth('Bearer x')).toBeNull()
  })

  it('checks credentials in full and rejects mismatches', () => {
    const expected = { user: 'exchange', pass: 'secret' }
    expect(checkCredentials({ user: 'exchange', pass: 'secret' }, expected)).toBe(true)
    expect(checkCredentials({ user: 'exchange', pass: 'nope' }, expected)).toBe(false)
    expect(checkCredentials({ user: 'other', pass: 'secret' }, expected)).toBe(false)
    expect(checkCredentials(null, expected)).toBe(false)
    expect(checkCredentials({ user: 'a', pass: 'b' }, {})).toBe(false)
  })

  it('signs an opaque journal session and rejects legacy/tampered tokens', () => {
    const token = mintSession('secret', 'session-123')
    expect(verifySession('secret', token)).toBe('session-123')
    expect(verifySession('other', token)).toBeNull()
    expect(verifySession('secret', token + 'a')).toBeNull()
    expect(verifySession('secret', '1c.9999999999999.sig')).toBeNull()
    expect(verifySession('secret', null)).toBeNull()
  })

  it('reads a named cookie from a raw header', () => {
    expect(readCookie('a=1; WSCEXAUTH=tok; b=2', 'WSCEXAUTH')).toBe('tok')
    expect(readCookie('a=1', 'WSCEXAUTH')).toBeNull()
    expect(readCookie(null, 'WSCEXAUTH')).toBeNull()
  })

  it('sanitises filenames and blocks path traversal', () => {
    expect(safeFilename('import___1.xml')).toBe('import___1.xml')
    expect(safeFilename('import_files/pic.jpg')).toBe('import_files/pic.jpg')
    expect(safeFilename('../../etc/passwd')).toBeNull()
    expect(safeFilename('..')).toBeNull()
    expect(safeFilename('bad name!.xml')).toBeNull()
    expect(safeFilename('')).toBeNull()
  })

  it('emits a well-formed empty CommerceML sale document', () => {
    const xml = emptySaleDocument(new Date('2026-09-17T10:00:00Z'))
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<КоммерческаяИнформация')
    expect(xml).toContain('</КоммерческаяИнформация>')
  })
})
