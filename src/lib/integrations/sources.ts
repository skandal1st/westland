import type { IntegrationConnection, IntegrationProvider, Prisma, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'

type Client = PrismaClient | Prisma.TransactionClient

export class SourceProfileError extends Error {
  constructor(public code: 'source_not_active' | 'ambiguous_active_source' | 'source_environment_locked' | 'source_not_found') {
    super(code)
    this.name = 'SourceProfileError'
  }
}

/** One explicit source per store, never first-enabled or any-connection fallback. */
export async function resolveActiveSource(storeId: string, provider?: IntegrationProvider, client: Client = defaultPrisma): Promise<IntegrationConnection | null> {
  const rows = await client.integrationConnection.findMany({ where: { storeId, sourceState: 'ACTIVE', enabled: true }, take: 2 })
  if (rows.length > 1) throw new SourceProfileError('ambiguous_active_source')
  const source = rows[0]
  return source && (!provider || source.provider === provider) ? source : null
}

/** A queued operation keeps its own source. It cannot follow a replacement. */
export async function requireActiveSource(connectionId: string, storeId: string, client: Client = defaultPrisma): Promise<IntegrationConnection> {
  const source = await client.integrationConnection.findUnique({ where: { id: connectionId } })
  if (!source || source.storeId !== storeId || !source.enabled || source.sourceState !== 'ACTIVE') throw new SourceProfileError('source_not_active')
  return source
}

/** Explicit public shape: config and credentials are never serialized here. */
export function publicSource(source: IntegrationConnection) {
  return { id: source.id, name: source.name, provider: source.provider, enabled: source.enabled,
    environment: source.environment, sourceState: source.sourceState,
    canSync: source.enabled && source.sourceState === 'ACTIVE' }
}
