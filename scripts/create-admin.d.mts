import type { PrismaClient } from '@prisma/client'
export function createAdministrator(db: PrismaClient, input: {
  storeCode: string
  email: string
  name: string
  password: string
}): Promise<{ id: string; email: string; role: string; store: string }>
