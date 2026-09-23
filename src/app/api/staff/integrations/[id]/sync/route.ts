import { CapabilityError } from '@/lib/capabilities'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { enqueueSourceSync } from '@/lib/integrations/sync-queue'
import { ProviderNotConfiguredError } from '@/lib/integrations/provider'
import { assertLicenseActive, LicenseError } from '@/lib/license'
import { latestSourceGeneration, requireSourceGeneration } from '@/lib/integrations/generations'
import { IntegrationInputError as ExchangeError } from '@/lib/integrations/errors'
import { requireActiveSource, SourceProfileError } from '@/lib/integrations/sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Trigger a full sync (catalog -> prices -> availability). Each step is a
 * durable dependency in PostgreSQL, executed by the separate worker.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const connection = await prisma.integrationConnection.findFirst({ where: { id: params.id, storeId: store.id } })
  if (!connection) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const rawBody = await request.text()
  const parsed = z.object({ generationId: z.string().min(1).optional() }).strict().safeParse(rawBody ? (() => { try { return JSON.parse(rawBody) } catch { return null } })() : {})
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })

  try {
    assertLicenseActive()
    await requireActiveSource(connection.id, store.id)
    const generation = connection.provider === 'ONE_C'
      ? parsed.data.generationId ? await requireSourceGeneration(connection.id, parsed.data.generationId) : await latestSourceGeneration(connection.id)
      : null
    if (connection.provider === 'ONE_C' && !generation) throw new ExchangeError('generation_required')
    const report = await enqueueSourceSync(connection, generation?.id)
    return NextResponse.json({ ...report, jobId: report.results[0]?.jobId }, { status: 202,
      headers: { Location: `/api/staff/integrations/${connection.id}/runs/${report.runId}` } })
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof ExchangeError) return NextResponse.json({ error: error.code }, { status: error.status })
    if (error instanceof SourceProfileError) return NextResponse.json({ error: error.code }, { status: 409 })
    if (error instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: 'provider_not_configured', provider: error.provider }, { status: 409 })
    }
    throw error
  }
}
