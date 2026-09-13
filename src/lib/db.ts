import { PrismaClient } from '@prisma/client'

/**
 * Single PrismaClient instance per process.
 *
 * In development Next.js hot-reload re-evaluates modules, which would otherwise
 * open a new connection pool on every change and exhaust Postgres. We cache the
 * client on globalThis to survive reloads. In production a fresh module graph
 * means a single instance.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
