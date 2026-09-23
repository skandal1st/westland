import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { recordAudit } from '@/lib/audit'
import { previewSourceTransition } from '@/lib/integrations/preflight'
import { IntegrationInputError } from '@/lib/integrations/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const schema = z.object({ generationId: z.string().min(1).max(128).optional() }).strict()

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['ADMIN'])
  if ('response' in auth) return auth.response
  const body = schema.safeParse(await request.json().catch(() => null))
  if (!body.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  const store = await getActiveStore()
  try {
    const report = await previewSourceTransition(store.id, params.id, body.data.generationId)
    await recordAudit(prisma, { storeId: store.id, actor: auth.user, action: 'SourceTransitionPreviewed',
      targetType: 'IntegrationConnection', targetId: params.id,
      metadata: { generationId: report.generation?.id ?? null, digest: report.digest, dataReady: report.dataReady,
        blockers: report.blockers.map(b => b.code), activationAllowed: false } })
    return NextResponse.json(report, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof IntegrationInputError) return NextResponse.json({ error: error.code }, { status: error.status })
    throw error
  }
}
