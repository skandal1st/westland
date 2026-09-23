import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { MappingSchema, ChannelMappingSchema, listSourceMappings, saveSourceMapping, saveSourceChannel } from '@/lib/integrations/mappings'
import { IntegrationInputError } from '@/lib/integrations/errors'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: { id: string } }
export async function GET(_request: Request, { params }: Context) {
  const auth = await requireApiUser(['STAFF', 'ADMIN']); if ('response' in auth) return auth.response
  try { return NextResponse.json(await listSourceMappings((await getActiveStore()).id, params.id)) }
  catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof IntegrationInputError) return NextResponse.json({ error: error.code }, { status: error.status }); throw error }
}
export async function POST(request: Request, { params }: Context) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core'); if ('response' in auth) return auth.response
  const body = await request.json().catch(() => null)
  const parsed = MappingSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  try { return NextResponse.json(await saveSourceMapping((await getActiveStore()).id, params.id, parsed.data, auth.user)) }
  catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof IntegrationInputError) return NextResponse.json({ error: error.code }, { status: error.status }); throw error }
}
export async function PUT(request: Request, { params }: Context) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core'); if ('response' in auth) return auth.response
  const parsed = ChannelMappingSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  try { return NextResponse.json(await saveSourceChannel((await getActiveStore()).id, params.id, parsed.data, auth.user)) }
  catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof IntegrationInputError) return NextResponse.json({ error: error.code }, { status: error.status }); throw error }
}
