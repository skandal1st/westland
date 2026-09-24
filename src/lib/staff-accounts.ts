import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/authz'

export class StaffAccountError extends Error {
  constructor(public code: 'FORBIDDEN' | 'EMAIL_EXISTS' | 'INVALID_INPUT') {
    super(code)
    this.name = 'StaffAccountError'
  }
}

type StaffRole = 'STAFF' | 'ADMIN'

export async function createStaffAccount(
  actor: SessionUser,
  input: { name: string; email: string; password: string; role: StaffRole },
) {
  const name = input.name.trim()
  const email = input.email.trim().toLowerCase()
  if (!name || name.length > 200 || !email || email.length > 254 || !['STAFF', 'ADMIN'].includes(input.role)
    || input.password.length < 12 || Buffer.byteLength(input.password, 'utf8') > 72) {
    throw new StaffAccountError('INVALID_INPUT')
  }

  const currentAdmin = await prisma.user.findFirst({ where: { id: actor.id, storeId: actor.storeId, role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } })
  if (!currentAdmin) throw new StaffAccountError('FORBIDDEN')
  const passwordHash = await bcrypt.hash(input.password, 12)

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${actor.id} AND "storeId" = ${actor.storeId} FOR SHARE`
      const admin = await tx.user.findFirst({ where: { id: actor.id, storeId: actor.storeId, role: 'ADMIN', status: 'ACTIVE' }, select: { id: true } })
      if (!admin) throw new StaffAccountError('FORBIDDEN')
      if (await tx.user.findFirst({ where: { storeId: actor.storeId, email: { equals: email, mode: 'insensitive' } }, select: { id: true } })) {
        throw new StaffAccountError('EMAIL_EXISTS')
      }

      const user = await tx.user.create({
        data: {
          storeId: actor.storeId,
          email,
          name,
          passwordHash,
          role: input.role,
          status: 'ACTIVE',
          moderatedById: actor.id,
          moderatedAt: new Date(),
        },
        select: { id: true, email: true, name: true, role: true, status: true, createdAt: true },
      })
      await recordAudit(tx, {
        storeId: actor.storeId,
        actor,
        action: 'StaffAccountCreated',
        targetType: 'User',
        targetId: user.id,
        summary: `Created ${user.role} account ${user.email}`,
        metadata: { email: user.email, role: user.role },
      })
      return user
    }, { isolationLevel: 'Serializable' })
  } catch (error) {
    if (error instanceof StaffAccountError) throw error
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw new StaffAccountError('EMAIL_EXISTS')
    throw error
  }
}
