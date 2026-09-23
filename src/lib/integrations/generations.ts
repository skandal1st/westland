import { prisma } from '@/lib/db'
import { latestGeneration, publishGeneration, requireGeneration } from './onec/ledger'
import type { UploadFile } from './onec/storage'
import { IntegrationInputError } from './errors'

export const latestSourceGeneration = latestGeneration
export const requireSourceGeneration = requireGeneration
export const publishSourceGeneration = publishGeneration
/** Public metadata only; credentials and the chunk journal never leave the adapter. */
export async function listSourceGenerations(storeId: string, connectionId: string) {
  const source = await prisma.integrationConnection.findFirst({ where: { id: connectionId, storeId: storeId, provider: 'ONE_C' } })
  if (!source) throw new IntegrationInputError('not_found', 404)
  const [sessions, generations] = await Promise.all([
    prisma.onecExchangeSession.findMany({ where: { connectionId: source.id, sourceRevision: source.exchangeRevision }, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, files: true, createdAt: true, closedAt: true } }),
    prisma.onecGeneration.findMany({ where: { connectionId: source.id, sourceRevision: source.exchangeRevision }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, digest: true, createdAt: true } }),
  ])
  return { sessions: sessions.map(session => ({ id: session.id, createdAt: session.createdAt, closedAt: session.closedAt,
    files: (session.files as unknown as UploadFile[]).map(file => ({ name: file.name, size: file.size, kind: file.kind, sha256: file.sha256, sealed: Boolean(file.sealedAt) })) })), generations }
}
