import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { publicSource } from '@/lib/integrations/sources'
import { recordAudit } from '@/lib/audit'

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
      runs: { where: { entityType: 'commerce.sync' }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, stats: true, createdAt: true, finishedAt: true } },
      checkpoints: { where: { entityType: 'product' }, take: 1 },
      jobs: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, type: true, status: true, attempts: true, finishedAt: true, lastError: true } },
    },
  })

  return NextResponse.json({
    connections: connections.map((c) => ({
      ...publicSource(c),
      checkpoint: c.checkpoints[0] ? { processed: c.checkpoints[0].processed, page: c.checkpoints[0].page, completed: c.checkpoints[0].completed, failed: c.checkpoints[0].failed } : null,
      lastJob: c.jobs[0] ?? null,
      lastRun: c.runs[0] ?? null,
    })),
  })
}

const createSchema = z.object({
  provider: z.enum(['ONE_C', 'MOYSKLAD', 'CUSTOM']),
  name: z.string().trim().min(1).max(160),
  environment: z.enum(['TEST', 'PRODUCTION']),
  enabled: z.literal(false).optional(),
  config: z.record(z.unknown()).optional(),
}).strict().superRefine((value, context) => {
  if (value.provider === 'ONE_C' && value.config !== undefined) {
    const config = z.object({ brandGroups: z.array(z.string().min(1).max(200)).max(5000).optional() }).strict().safeParse(value.config)
    if (!config.success) context.addIssue({ code: 'custom', path: ['config'], message: 'Only brandGroups may be stored in a 1C profile; credentials belong in secret storage' })
  }
})

export async function POST(request: Request) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  try {
    const connection = await prisma.$transaction(async (tx) => {
      const created = await tx.integrationConnection.create({
        data: { storeId: store.id, provider: parsed.data.provider, name: parsed.data.name, environment: parsed.data.environment,
          sourceState: 'PREPARING', enabled: false, config: (parsed.data.config ?? undefined) as any },
      })
      await recordAudit(tx, { storeId: store.id, actor: auth.user, action: 'IntegrationSourceCreated', targetType: 'IntegrationConnection',
        targetId: created.id, summary: 'Source profile prepared', metadata: { environment: created.environment, provider: created.provider } })
      return created
    })
    return NextResponse.json(publicSource(connection), { status: 201 })
  } catch {
    return NextResponse.json({ error: 'conflict' }, { status: 409 })
  }
}
