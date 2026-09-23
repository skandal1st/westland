import { assertCapability } from '@/lib/capabilities'
import crypto from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma as db } from '@/lib/db'
import { credentialDigest, type SourceCredential } from './credentials'
import { ExchangeError, CHUNK_LIMIT, FILE_LIMIT, SESSION_LIMIT, sha256, storeChunk, sealFile, type UploadFile, type GenerationFile } from './storage'

type Tx = Prisma.TransactionClient
/** Preparation accepts isolated inbound files only; import/export still require ACTIVE. */
function acceptsFiles(source: { sourceState: string; enabled: boolean; environment: string }) {
  return (source.sourceState === 'ACTIVE' && source.enabled)
    || (source.sourceState === 'PREPARING' && !source.enabled && source.environment !== 'UNCLASSIFIED')
}
export type SessionAuthority = { storeId: string; sessionId: string; credentials: SourceCredential[]; secret: string }
const filesOf = (files: Prisma.JsonValue) => files as unknown as UploadFile[]
async function lockSource(tx: Tx, connectionId: string, storeId: string) {
  await tx.$queryRaw`SELECT "id" FROM "IntegrationConnection" WHERE "id" = ${connectionId} FOR UPDATE`
  const source = await tx.integrationConnection.findUnique({ where: { id: connectionId } })
  if (!source || source.storeId !== storeId || source.provider !== 'ONE_C' || !acceptsFiles(source)) throw new ExchangeError('source_not_active', 503)
  return source
}
export async function openExchangeSession(storeId: string, credential: SourceCredential, secret: string, client: PrismaClient = db) {
  assertCapability('commerce-core')

  return client.$transaction(async tx => {
    const source = await lockSource(tx, credential.connectionId, storeId)
    return tx.onecExchangeSession.create({ data: { connectionId: source.id, sourceRevision: source.exchangeRevision, credentialDigest: credentialDigest(credential, secret), expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000) } })
  })
}
export async function authenticateSession(authority: SessionAuthority, client: PrismaClient | Tx = db) {
  const session = await client.onecExchangeSession.findUnique({ where: { id: authority.sessionId }, include: { connection: true } })
  if (!session || session.expiresAt.getTime() <= Date.now()) throw new ExchangeError('session_expired_or_unknown', 401)
  const credential = authority.credentials.find(row => row.connectionId === session.connectionId)
  if (!credential || credentialDigest(credential, authority.secret) !== session.credentialDigest) throw new ExchangeError('session_credentials_changed', 401)
  const source = session.connection
  if (source.storeId !== authority.storeId || source.provider !== 'ONE_C' || !acceptsFiles(source) || source.exchangeRevision !== session.sourceRevision) throw new ExchangeError('session_source_changed', 401)
  return session
}
async function mutate<T>(authority: SessionAuthority, fn: (tx: Tx, session: Awaited<ReturnType<typeof authenticateSession>>) => Promise<T>, client: PrismaClient) {
  assertCapability('commerce-core')

  return client.$transaction(async tx => {
    const initial = await tx.onecExchangeSession.findUnique({ where: { id: authority.sessionId }, select: { connectionId: true } })
    if (!initial) throw new ExchangeError('session_expired_or_unknown', 401)
    await lockSource(tx, initial.connectionId, authority.storeId)
    return fn(tx, await authenticateSession(authority, tx))
  }, { timeout: 120_000 })
}
export async function initializeSession(authority: SessionAuthority, client: PrismaClient = db) {
  return mutate(authority, async (tx, session) => {
    if (session.closedAt) throw new ExchangeError('session_closed')
    if (!session.initializedAt) await tx.onecExchangeSession.update({ where: { id: session.id }, data: { initializedAt: new Date() } })
  }, client)
}
export async function receiveChunk(authority: SessionAuthority, name: string, bytes: Buffer, client: PrismaClient = db) {
  if (!bytes.length || bytes.length > CHUNK_LIMIT) throw new ExchangeError('invalid_chunk_size', 413)
  return mutate(authority, async (tx, session) => {
    if (!session.initializedAt || session.closedAt) throw new ExchangeError('session_not_open')
    const files = filesOf(session.files), digest = sha256(bytes)
    let file = files.find(f => f.name === name)
    if (!file) {
      if (files.length >= 128) throw new ExchangeError('too_many_files', 413)
      file = { id: crypto.randomUUID(), name, size: 0, chunks: [] }; files.push(file)
    }
    // Standard 1C sends neither sequence nor offset. Guessing that identical
    // bytes are a retry can silently discard legitimate repeated content.
    if (file.chunks.some(chunk => chunk.sha256 === digest)) throw new ExchangeError('ambiguous_chunk_repeat_restart_exchange')
    if (file.sealedAt) throw new ExchangeError('file_already_sealed')
    if (file.size + bytes.length > FILE_LIMIT || files.reduce((n, f) => n + f.size, 0) + bytes.length > SESSION_LIMIT || file.chunks.length >= 8192) throw new ExchangeError('upload_limit_exceeded', 413)
    await storeChunk(session.connectionId, session.id, file.id, bytes)
    file.chunks.push({ offset: file.size, size: bytes.length, sha256: digest }); file.size += bytes.length
    await tx.onecExchangeSession.update({ where: { id: session.id }, data: { files: files as unknown as Prisma.InputJsonValue } })
    return { size: file.size }
  }, client)
}
export async function finishFile(authority: SessionAuthority, name: string, client: PrismaClient = db) {
  return mutate(authority, async (tx, session) => {
    const files = filesOf(session.files), index = files.findIndex(file => file.name === name)
    if (index < 0) throw new ExchangeError('file_not_received')
    if (files[index].sealedAt) return // mode=import is safely repeatable.
    if (!session.initializedAt || session.closedAt) throw new ExchangeError('session_not_open')
    files[index] = await sealFile(session.connectionId, session.id, files[index])
    await tx.onecExchangeSession.update({ where: { id: session.id }, data: { files: files as unknown as Prisma.InputJsonValue } })
  }, client)
}
export async function closeSession(authority: SessionAuthority, client: PrismaClient = db) {
  return mutate(authority, async (tx, session) => {
    const files = filesOf(session.files)
    for (let i = 0; i < files.length; i++) if (!files[i].sealedAt && !files[i].name.toLowerCase().endsWith('.xml')) files[i] = await sealFile(session.connectionId, session.id, files[i])
    if (!files.length || files.some(file => !file.sealedAt)) throw new ExchangeError('session_files_incomplete')
    if (!session.closedAt) await tx.onecExchangeSession.update({ where: { id: session.id }, data: { closedAt: new Date(), files: files as unknown as Prisma.InputJsonValue } })
  }, client)
}

/** Only an explicit reviewed list, never latest import + latest offers guessing. */
export async function publishGeneration(storeId: string, connectionId: string, sessionIds: string[], actor: { id: string; email: string }, client: PrismaClient = db) {
  assertCapability('commerce-core')

  if (!sessionIds.length || sessionIds.length > 32 || new Set(sessionIds).size !== sessionIds.length) throw new ExchangeError('invalid_session_selection', 400)
  return client.$transaction(async tx => {
    const source = await lockSource(tx, connectionId, storeId)
    const sessions = await tx.onecExchangeSession.findMany({ where: { id: { in: sessionIds } }, orderBy: { id: 'asc' } })
    if (sessions.length !== sessionIds.length) throw new ExchangeError('session_not_found')
    const files: GenerationFile[] = []
    for (const session of sessions) {
      if (session.connectionId !== source.id || session.sourceRevision !== source.exchangeRevision) throw new ExchangeError('session_source_changed')
      const uploaded = filesOf(session.files)
      for (let i = 0; i < uploaded.length; i++) if (!uploaded[i].sealedAt && !uploaded[i].name.toLowerCase().endsWith('.xml')) uploaded[i] = await sealFile(session.connectionId, session.id, uploaded[i])
      if (!uploaded.length || uploaded.some(file => !file.sha256 || !file.kind || !file.sealedAt)) throw new ExchangeError('session_files_incomplete')
      await tx.onecExchangeSession.update({ where: { id: session.id }, data: { files: uploaded as unknown as Prisma.InputJsonValue } })
      for (const file of uploaded) files.push({ sessionId: session.id, id: file.id, name: file.name, size: file.size, sha256: file.sha256!, kind: file.kind! })
    }
    if (new Set(files.map(file => file.name)).size !== files.length) throw new ExchangeError('duplicate_manifest_filename')
    if (!files.some(f => f.kind === 'catalog' || f.kind === 'offers')) throw new ExchangeError('exchange_data_required')
    files.sort((a, b) => a.name.localeCompare(b.name))
    const digest = sha256(JSON.stringify(files))
    await tx.onecExchangeSession.updateMany({ where: { id: { in: sessionIds }, closedAt: null }, data: { closedAt: new Date() } })
    const existing = await tx.onecGeneration.findUnique({ where: { connectionId_sourceRevision_digest: { connectionId, sourceRevision: source.exchangeRevision, digest } } })
    if (existing) return existing
    const generation = await tx.onecGeneration.create({ data: { connectionId, sourceRevision: source.exchangeRevision, digest, files: files as unknown as Prisma.InputJsonValue } })
    await tx.auditEntry.create({ data: { storeId, actorId: actor.id, actorEmail: actor.email, action: 'OnecGenerationPublished', targetType: 'OnecGeneration', targetId: generation.id, metadata: { connectionId, sessionIds, digest } } })
    return generation
  }, { timeout: 120_000 })
}
export async function requireGeneration(connectionId: string, generationId: string, client: PrismaClient | Tx = db) {
  const generation = await client.onecGeneration.findUnique({ where: { id: generationId }, include: { connection: true } })
  if (!generation || generation.connectionId !== connectionId || generation.sourceRevision !== generation.connection.exchangeRevision || !generation.connection.enabled || generation.connection.sourceState !== 'ACTIVE') throw new ExchangeError('generation_source_changed')
  return generation
}
export async function latestGeneration(connectionId: string, client: PrismaClient = db) {
  const source = await client.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
  if (!source.enabled || source.sourceState !== 'ACTIVE') return null
  return client.onecGeneration.findFirst({ where: { connectionId, sourceRevision: source.exchangeRevision }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
}
