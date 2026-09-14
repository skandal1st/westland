import type { Prisma, PrismaClient } from '@prisma/client'

/**
 * Append-only audit of critical staff/admin actions (see plan §3). Not
 * analytics domain events — this records "who changed what by hand". Later
 * milestones add their own action strings against the same mechanism.
 */
export const AuditAction = {
  RegistrationApproved: 'RegistrationApproved',
  RegistrationRejected: 'RegistrationRejected',
  UserSuspended: 'UserSuspended',
  UserReactivated: 'UserReactivated',
  ProductContentUpdated: 'ProductContentUpdated',
  PriceGroupChanged: 'PriceGroupChanged',
  FulfillmentChannelChanged: 'FulfillmentChannelChanged',
} as const

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction] | (string & {})

type AuditActor = { id: string; email: string } | null | undefined

/** Accepts a tx client so callers can record inside a transaction atomically. */
type Client = PrismaClient | Prisma.TransactionClient

export async function recordAudit(
  client: Client,
  entry: {
    storeId: string
    actor?: AuditActor
    action: AuditActionName
    targetType: string
    targetId: string
    summary?: string
    metadata?: Prisma.InputJsonValue
  },
): Promise<void> {
  await client.auditEntry.create({
    data: {
      storeId: entry.storeId,
      actorId: entry.actor?.id ?? null,
      actorEmail: entry.actor?.email ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      summary: entry.summary,
      metadata: entry.metadata,
    },
  })
}
