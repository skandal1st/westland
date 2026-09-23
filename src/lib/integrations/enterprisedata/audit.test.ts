import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendTransportAudit } from './audit'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true }) })
it('rotates a bounded audit without losing the latest events or touching protocol state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-audit-')); dirs.push(dir)
  const file = path.join(dir, 'audit.jsonl')
  fs.writeFileSync(path.join(dir, 'state.json'), 'unchanged')
  for (let n = 0; n < 20; n++) appendTransportAudit(file, { n }, 20, 2)
  expect(fs.readdirSync(dir).sort()).toEqual(['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2', 'state.json'])
  expect(fs.readFileSync(file, 'utf8')).toContain('"n":19')
  for (const name of ['audit.jsonl', 'audit.jsonl.1', 'audit.jsonl.2']) {
    const bytes = fs.readFileSync(path.join(dir, name), 'utf8')
    expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(20)
    for (const row of bytes.trim().split('\n')) expect(() => JSON.parse(row)).not.toThrow()
  }
  expect(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).toBe('unchanged')
})
it('does not mask filesystem failures', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-audit-')); dirs.push(dir)
  expect(() => appendTransportAudit(dir, { ok: true })).toThrow()
})
