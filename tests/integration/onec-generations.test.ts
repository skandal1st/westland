import { afterAll, afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { openExchangeSession, initializeSession, receiveChunk, finishFile, publishGeneration, authenticateSession, latestGeneration, type SessionAuthority } from '@/lib/integrations/onec/ledger'
import { CHUNK_LIMIT, readLimitedBody, sealedPath, type GenerationFile } from '@/lib/integrations/onec/storage'
import { sourceCredentials } from '@/lib/integrations/onec/credentials'
import { createOneCProvider } from '@/lib/integrations/onec/provider'
import { enqueueJob, runJob, JOB_CATALOG_IMPORT } from '@/lib/integrations/jobs'
import { importCatalog } from '@/lib/integrations/import-catalog'

const db = new PrismaClient(), stores: string[] = []
const secret = 'test-secret', oldDir = process.env.ONEC_EXCHANGE_DIR
let storeId: string, connectionId: string, root: string, actor: { id: string; email: string }
const catalog = (sku = 'SKU-A') => `<КоммерческаяИнформация><Каталог><Товары><Товар><Ид>product-1</Ид><Артикул>${sku}</Артикул><Наименование>Товар</Наименование></Товар></Товары></Каталог></КоммерческаяИнформация>`
const offers = '<КоммерческаяИнформация><ПакетПредложений><Предложения><Предложение><Ид>product-1</Ид><Цены><Цена><ЦенаЗаЕдиницу>12</ЦенаЗаЕдиницу></Цена></Цены></Предложение></Предложения></ПакетПредложений></КоммерческаяИнформация>'
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'onec-ledger-'))
  process.env.ONEC_EXCHANGE_DIR = root
  storeId = (await db.store.create({ data: { slug: `r09-${randomUUID()}`, name: 'R09' } })).id; stores.push(storeId)
  connectionId = (await db.integrationConnection.create({ data: { storeId, provider: 'ONE_C', name: 'test', sourceState: 'ACTIVE', enabled: true, environment: 'TEST' } })).id
  actor = await db.user.create({ data: { storeId, email: 'admin@test.local', name: 'Admin', passwordHash: 'fixture', role: 'ADMIN' } })
})
afterEach(async () => {
  for (const id of stores.splice(0)) {
    await db.providerSnapshot.deleteMany({ where: { storeId: id } }); await db.inbox.deleteMany({ where: { storeId: id } }); await db.integrationError.deleteMany({ where: { storeId: id } })
    await db.store.delete({ where: { id } })
  }
})
afterAll(async () => { if (oldDir === undefined) delete process.env.ONEC_EXCHANGE_DIR; else process.env.ONEC_EXCHANGE_DIR = oldDir; await db.$disconnect() })
async function session() {
  const credential = { connectionId, user: 'onec', pass: 'test-password' }
  const opened = await openExchangeSession(storeId, credential, secret, db)
  const authority: SessionAuthority = { storeId, sessionId: opened.id, credentials: [credential], secret }
  await initializeSession(authority, db)
  return authority
}
async function upload(name: string, body: string) {
  const authority = await session()
  await receiveChunk(authority, name, Buffer.from(body), db)
  await finishFile(authority, name, db)
  return authority
}
async function generation(sku = 'SKU-A') {
  const a = await upload('import.xml', catalog(sku)), b = await upload('offers.xml', offers)
  return publishGeneration(storeId, connectionId, [a.sessionId, b.sessionId], actor, db)
}

it('durable chunks survive a new DB client and init retry; ambiguous duplicate never adds bytes', async () => {
  const authority = await session(), bytes = Buffer.from(catalog()), half = Math.floor(bytes.length / 2)
  await receiveChunk(authority, 'import.xml', bytes.subarray(0, half), db)
  const restarted = new PrismaClient()
  try {
    await initializeSession(authority, restarted)
    await expect(receiveChunk(authority, 'import.xml', bytes.subarray(0, half), restarted)).rejects.toMatchObject({ code: 'ambiguous_chunk_repeat_restart_exchange' })
    await expect(finishFile(authority, 'import.xml', restarted)).rejects.toMatchObject({ code: 'incomplete_or_invalid_xml' })
    await receiveChunk(authority, 'import.xml', bytes.subarray(half), restarted)
    await finishFile(authority, 'import.xml', restarted); await finishFile(authority, 'import.xml', restarted)
  } finally { await restarted.$disconnect() }
  const b = await upload('offers.xml', offers)
  const ready = await publishGeneration(storeId, connectionId, [authority.sessionId, b.sessionId], actor, db)
  const file = (ready.files as unknown as GenerationFile[]).find(f => f.kind === 'catalog')!
  expect(await fs.readFile(sealedPath(connectionId, file))).toEqual(bytes)
  expect(file.size).toBe(bytes.length)
})

it('concurrent identical chunks commit once; different sessions never share bytes', async () => {
  const a = await session(), b = await session(), bytes = Buffer.from(catalog())
  const results = await Promise.allSettled([receiveChunk(a, 'import.xml', bytes, db), receiveChunk(a, 'import.xml', bytes, db)])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
  await receiveChunk(b, 'import.xml', Buffer.from(catalog('OTHER')), db)
  await finishFile(a, 'import.xml', db); await finishFile(b, 'import.xml', db)
  const rows = await db.onecExchangeSession.findMany({ where: { connectionId } })
  expect(rows).toHaveLength(2)
  expect(JSON.stringify(rows[0].files)).not.toBe(JSON.stringify(rows[1].files))
})

it('only explicitly selected complete catalog/offers can become a generation', async () => {
  const a = await upload('import.xml', catalog()), b = await session()
  await receiveChunk(b, 'offers.xml', Buffer.from(offers.slice(0, 40)), db)
  await expect(publishGeneration(storeId, connectionId, [a.sessionId, b.sessionId], actor, db)).rejects.toMatchObject({ code: 'session_files_incomplete' })
  expect(await latestGeneration(connectionId, db)).toBeNull()
  const c = await upload('offers.xml', offers)
  const ready = await publishGeneration(storeId, connectionId, [a.sessionId, c.sessionId], actor, db)
  expect((await publishGeneration(storeId, connectionId, [c.sessionId, a.sessionId], actor, db)).id).toBe(ready.id)
  await expect(receiveChunk(a, 'new.xml', Buffer.from(catalog()), db)).rejects.toMatchObject({ code: 'session_not_open' })
})

it('cookie scope rejects credential rotation, expiry and disable/reactivate, not just a different active source', async () => {
  const authority = await session()
  await expect(authenticateSession({ ...authority, credentials: [{ ...authority.credentials[0], pass: 'rotated' }] }, db)).rejects.toMatchObject({ code: 'session_credentials_changed' })
  await db.onecExchangeSession.update({ where: { id: authority.sessionId }, data: { expiresAt: new Date(0) } })
  await expect(authenticateSession(authority, db)).rejects.toMatchObject({ code: 'session_expired_or_unknown' })
  const fresh = await session()
  await db.integrationConnection.update({ where: { id: connectionId }, data: { sourceState: 'RETIRED', enabled: false } })
  await db.integrationConnection.update({ where: { id: connectionId }, data: { sourceState: 'ACTIVE', enabled: true } })
  await expect(receiveChunk(fresh, 'import.xml', Buffer.from(catalog()), db)).rejects.toMatchObject({ code: 'session_source_changed' })
})

it('provider reads its immutable generation, ignores legacy/open files and detects sealed-file corruption', async () => {
  const first = await generation('OLD'), provider = createOneCProvider(connectionId, first.id)
  await fs.mkdir(path.join(root, 'catalog')); await fs.writeFile(path.join(root, 'catalog', 'import-stale.xml'), catalog('GHOST'))
  await generation('NEW')
  const pending = await session(); await receiveChunk(pending, 'import.xml', Buffer.from(catalog('PENDING')), db)
  expect((await provider.pullProducts()).items).toMatchObject([{ sku: 'OLD' }])
  expect((await createOneCProvider(connectionId, (await latestGeneration(connectionId, db))!.id).pullProducts()).items).toMatchObject([{ sku: 'NEW' }])
  const file = (first.files as unknown as GenerationFile[]).find(f => f.kind === 'catalog')!
  await fs.writeFile(sealedPath(connectionId, file), 'corrupted')
  await expect(createOneCProvider(connectionId, first.id).pullProducts()).rejects.toMatchObject({ code: 'generation_file_integrity_failed' })
})

it('jobs pin generation; a different generation cannot resume a non-completed checkpoint', async () => {
  const first = await generation('OLD')
  const job = await enqueueJob({ storeId, connectionId, type: JOB_CATALOG_IMPORT }, db)
  const second = await generation('NEW')
  expect(job.generationId).toBe(first.id)
  await db.syncCheckpoint.create({ data: { connectionId, entityType: 'product', generationId: first.id, page: 1, cursor: '500', processed: 500, completed: false } })
  await expect(importCatalog({ storeId, connectionId, generationId: second.id, provider: createOneCProvider(connectionId, second.id) }, db)).rejects.toMatchObject({ code: 'checkpoint_generation_mismatch' })
  expect((await db.syncCheckpoint.findUniqueOrThrow({ where: { connectionId_entityType: { connectionId, entityType: 'product' } } })).cursor).toBe('500')
  await db.syncCheckpoint.updateMany({ where: { connectionId }, data: { completed: true } })
  const wrong = await runJob(job, { provider: createOneCProvider(connectionId, second.id) }, db)
  expect(wrong.message).toBe('job_generation_mismatch')
  expect((await importCatalog({ storeId, connectionId, generationId: second.id, provider: createOneCProvider(connectionId, second.id) }, db)).imported).toBe(1)
  expect((await db.syncCheckpoint.findUniqueOrThrow({ where: { connectionId_entityType: { connectionId, entityType: 'product' } } })).generationId).toBe(second.id)
})

it('actual body limit works without content-length; no oversized journal entry is created', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(CHUNK_LIMIT)); controller.enqueue(new Uint8Array(1)) }, cancel() { cancelled = true } })
  const request = new Request('http://test', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
  await expect(readLimitedBody(request)).rejects.toMatchObject({ code: 'chunk_too_large', status: 413 })
  expect(cancelled).toBe(true)
  const authority = await session()
  await expect(receiveChunk(authority, 'import.xml', Buffer.alloc(CHUNK_LIMIT + 1), db)).rejects.toMatchObject({ status: 413 })
  expect((await db.onecExchangeSession.findUniqueOrThrow({ where: { id: authority.sessionId } })).files).toEqual([])
})

it('per-source secret file rejects shared logins and legacy credentials without an explicit binding', async () => {
  const old = { file: process.env.ONEC_SOURCES_FILE, id: process.env.ONEC_EXCHANGE_CONNECTION_ID }
  try {
    process.env.ONEC_SOURCES_FILE = path.join(root, 'credentials.json')
    await fs.writeFile(process.env.ONEC_SOURCES_FILE, JSON.stringify([{ connectionId, user: 'shared', pass: 'one' }, { connectionId: 'other', user: 'shared', pass: 'two' }]))
    await expect(sourceCredentials()).rejects.toMatchObject({ code: 'source_credentials_ambiguous' })
    delete process.env.ONEC_SOURCES_FILE; delete process.env.ONEC_EXCHANGE_CONNECTION_ID
    await expect(sourceCredentials()).rejects.toMatchObject({ code: 'source_credentials_not_configured' })
  } finally {
    if (old.file === undefined) delete process.env.ONEC_SOURCES_FILE; else process.env.ONEC_SOURCES_FILE = old.file
    if (old.id === undefined) delete process.env.ONEC_EXCHANGE_CONNECTION_ID; else process.env.ONEC_EXCHANGE_CONNECTION_ID = old.id
  }
})


it('assets sent without mode=import are sealed with the explicitly selected sessions', async () => {
  const a = await upload('import.xml', catalog()), b = await upload('offers.xml', offers)
  await receiveChunk(a, 'import_files/photo.jpg', Buffer.from('binary-image-fixture'), db)
  const ready = await publishGeneration(storeId, connectionId, [a.sessionId, b.sessionId], actor, db)
  const asset = (ready.files as unknown as GenerationFile[]).find(file => file.kind === 'asset')!
  expect(asset.name).toBe('import_files/photo.jpg')
  expect((await fs.readFile(sealedPath(connectionId, asset))).toString()).toBe('binary-image-fixture')
})

it('orphan chunk bytes after a rolled-back journal write can be retried without duplication', async () => {
  const authority = await session(), constraint = `r09_${randomUUID().replaceAll('-', '')}`
  await db.$executeRawUnsafe(`ALTER TABLE "OnecExchangeSession" ADD CONSTRAINT "${constraint}" CHECK ("id" <> '${authority.sessionId}' OR jsonb_array_length("files") = 0)`)
  try { await expect(receiveChunk(authority, 'import.xml', Buffer.from(catalog()), db)).rejects.toThrow() }
  finally { await db.$executeRawUnsafe(`ALTER TABLE "OnecExchangeSession" DROP CONSTRAINT "${constraint}"`) }
  expect((await db.onecExchangeSession.findUniqueOrThrow({ where: { id: authority.sessionId } })).files).toEqual([])
  await receiveChunk(authority, 'import.xml', Buffer.from(catalog()), db); await finishFile(authority, 'import.xml', db)
  const files = (await db.onecExchangeSession.findUniqueOrThrow({ where: { id: authority.sessionId } })).files as unknown as { size: number; chunks: unknown[] }[]
  expect(files[0].size).toBe(Buffer.byteLength(catalog())); expect(files[0].chunks).toHaveLength(1)
})

it('publishing sessions of another source/store is rejected even when XML names match', async () => {
  const a = await upload('import.xml', catalog()), b = await upload('offers.xml', offers)
  const otherStore = (await db.store.create({ data: { slug: `other-${randomUUID()}`, name: 'Other' } })).id; stores.push(otherStore)
  const other = await db.integrationConnection.create({ data: { storeId: otherStore, provider: 'ONE_C', name: 'other', sourceState: 'ACTIVE', enabled: true } })
  const cred = { connectionId: other.id, user: 'other', pass: 'password' }
  const foreign = await openExchangeSession(otherStore, cred, secret, db)
  await expect(publishGeneration(storeId, connectionId, [a.sessionId, b.sessionId, foreign.id], actor, db)).rejects.toMatchObject({ code: 'session_source_changed' })
  expect(await latestGeneration(connectionId, db)).toBeNull()
})
