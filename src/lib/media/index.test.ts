import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getMediaStore, setMediaStore } from './index'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'axima-private-media-'))
  vi.stubEnv('MEDIA_ROOT', root)
  setMediaStore(null)
})
afterEach(async () => { setMediaStore(null); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }) })

it('persists private artifacts across a new store instance', async () => {
  const first = getMediaStore()
  expect(await first.get('invoices/one-v1.pdf')).toBeNull()
  await first.put('invoices/one-v1.pdf', Buffer.from('complete PDF bytes'))
  setMediaStore(null)
  expect(await getMediaStore().get('invoices/one-v1.pdf')).toEqual(Buffer.from('complete PDF bytes'))
  expect(await fs.readdir(path.join(root, 'invoices'))).toEqual(['one-v1.pdf'])
  if (process.platform !== 'win32') expect((await fs.stat(path.join(root, 'invoices/one-v1.pdf'))).mode & 0o777).toBe(0o600)
})

it('concurrent readers see either complete old or complete new bytes, never partial output', async () => {
  const store = getMediaStore(), key = 'invoices/race-v1.pdf'
  const old = Buffer.alloc(2 * 1024 * 1024, 1), next = Buffer.alloc(2 * 1024 * 1024, 2)
  await store.put(key, old)
  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => store.put(key, i % 2 ? old : next)),
    (async () => { for (let i = 0; i < 20; i++) { const bytes = await store.get(key); expect(bytes?.equals(old) || bytes?.equals(next)).toBe(true) } })(),
  ])
  expect(await fs.readdir(path.join(root, 'invoices'))).toEqual(['race-v1.pdf'])
})

it.each(['../secret', 'invoices/../../secret', '/absolute', 'C:/absolute', 'invoices\\outside', '', 'invoices//empty', './file'])('rejects unsafe key %j without writing outside the cache', async key => {
  const store = getMediaStore()
  await expect(store.put(key, Buffer.from('no'))).rejects.toThrow('invalid media key')
  await expect(store.get(key)).rejects.toThrow('invalid media key')
  expect(await fs.readdir(root)).toEqual([])
})

it.each(['public', 'public/invoices', '.next/static'])('refuses a statically served cache root %s', value => {
  vi.stubEnv('MEDIA_ROOT', path.join(process.cwd(), value))
  expect(() => getMediaStore()).toThrow('outside public')
})

it('does not disguise storage errors as cache misses and cleans a failed publish', async () => {
  const store = getMediaStore()
  await fs.mkdir(path.join(root, 'invoices/blocked.pdf'), { recursive: true })
  await expect(store.get('invoices/blocked.pdf')).rejects.toThrow()
  await expect(store.put('invoices/blocked.pdf', Buffer.from('pdf'))).rejects.toThrow()
  expect(await fs.readdir(path.join(root, 'invoices'))).toEqual(['blocked.pdf'])
})
