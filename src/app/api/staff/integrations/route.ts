import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const connections = await prisma.integrationConnection.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: 'asc' },
    include: {
      checkpoints: { where: { entityType: 'product' }, take: 1 },
      jobs: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, type: true, status: true, attempts: true, finishedAt: true, lastError: true } },
    },
  })

  return NextResponse.json({
    connections: connections.map((c) => ({
      id: c.id,
      provider: c.provider,
      name: c.name,
      enabled: c.enabled,
      checkpoint: c.checkpoints[0] ? { processed: c.checkpoints[0].processed, page: c.checkpoints[0].page, completed: c.checkpoints[0].completed } : null,
      lastJob: c.jobs[0] ?? null,
    })),
  })
}

const createSchema = z.object({
  provider: z.enum(['ONE_C', 'MOYSKLAD', 'CUSTOM']),
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
})

export async function POST(request: Request) {
  const auth = await requireApiUser(['ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  try {
    const connection = await prisma.integrationConnection.create({
      data: { storeId: store.id, provider: parsed.data.provider, name: parsed.data.name, enabled: parsed.data.enabled ?? false, config: (parsed.data.config ?? undefined) as any },
    })
    return NextResponse.json({ id: connection.id }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'conflict' }, { status: 409 })
  }
}
