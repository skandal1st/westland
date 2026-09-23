import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { publicSource, SourceProfileError } from '@/lib/integrations/sources'
import { recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  environment: z.enum(['TEST', 'PRODUCTION']).optional(),
}).strict().refine(value => Object.keys(value).length > 0)

/** Metadata only. Activation/retirement requires the later cutover workflow. */
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  try {
    const source = await prisma.$transaction(async tx => {
      const current = await tx.integrationConnection.findUnique({ where: { id: params.id } })
      if (!current || current.storeId !== store.id) throw new SourceProfileError('source_not_found')
      if (parsed.data.environment && current.sourceState !== 'PREPARING' && current.environment !== 'UNCLASSIFIED' && parsed.data.environment !== current.environment) {
        throw new SourceProfileError('source_environment_locked')
      }
      const changed = await tx.integrationConnection.updateMany({ where: { id: current.id, updatedAt: current.updatedAt }, data: parsed.data })
      if (changed.count !== 1) throw new SourceProfileError('source_environment_locked')
      await recordAudit(tx, { storeId: store.id, actor: auth.user, action: 'IntegrationSourceProfileUpdated', targetType: 'IntegrationConnection',
        targetId: current.id, summary: 'Source metadata updated', metadata: { previousEnvironment: current.environment, environment: parsed.data.environment ?? current.environment } })
      return tx.integrationConnection.findUniqueOrThrow({ where: { id: current.id } })
    })
    return NextResponse.json(publicSource(source))
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof SourceProfileError) return NextResponse.json({ error: error.code }, { status: error.code === 'source_not_found' ? 404 : 409 })
    if ((error as { code?: string }).code === 'P2002') return NextResponse.json({ error: 'conflict' }, { status: 409 })
    throw error
  }
}
