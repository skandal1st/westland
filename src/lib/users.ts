import { prisma } from '@/lib/db'
import { AuditAction, recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/authz'

export class UserActionError extends Error {
  constructor(public code: 'NOT_FOUND' | 'CANNOT_SUSPEND_ADMIN') {
    super(code)
    this.name = 'UserActionError'
  }
}

/** Suspend a buyer's access. Admins cannot be suspended through this path. */
export async function suspendUser(userId: string, options: { actor: SessionUser | null }) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } })
    if (!user) throw new UserActionError('NOT_FOUND')
    if (user.role === 'ADMIN') throw new UserActionError('CANNOT_SUSPEND_ADMIN')

    const updated = await tx.user.update({ where: { id: userId }, data: { status: 'SUSPENDED' } })
    await recordAudit(tx, {
      storeId: user.storeId,
      actor: options.actor,
      action: AuditAction.UserSuspended,
      targetType: 'User',
      targetId: userId,
      summary: `Suspended ${user.email}`,
    })
    return updated
  })
}

export async function reactivateUser(userId: string, options: { actor: SessionUser | null }) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } })
    if (!user) throw new UserActionError('NOT_FOUND')

    const updated = await tx.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } })
    await recordAudit(tx, {
      storeId: user.storeId,
      actor: options.actor,
      action: AuditAction.UserReactivated,
      targetType: 'User',
      targetId: userId,
      summary: `Reactivated ${user.email}`,
    })
    return updated
  })
}
