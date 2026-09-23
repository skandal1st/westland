import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { listSourceGenerations, publishSourceGeneration } from '@/lib/integrations/generations'
import { IntegrationInputError } from '@/lib/integrations/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  try { return NextResponse.json(await listSourceGenerations(store.id, params.id)) }
  catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof IntegrationInputError) return NextResponse.json({ error: error.code }, { status: error.status })
    throw error
  }
}
const schema = z.object({ sessionIds: z.array(z.string().min(1)).min(1).max(32) }).strict()
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const body = schema.safeParse(await request.json().catch(() => null))
  if (!body.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  try {
    const generation = await publishSourceGeneration(store.id, params.id, body.data.sessionIds, auth.user)
    return NextResponse.json({ id: generation.id, digest: generation.digest, createdAt: generation.createdAt }, { status: 201 })
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof IntegrationInputError) return NextResponse.json({ error: error.code }, { status: error.status })
    throw error
  }
}
