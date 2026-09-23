import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/authz'
import { importPartners, MAX_PARTNER_BYTES } from '@/lib/integrations/enterprisedata/partners'
import { IntegrationInputError } from '@/lib/integrations/errors'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, {params}: {params: {id: string}}) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  if (Number(request.headers.get('content-length') ?? 0) > MAX_PARTNER_BYTES) return NextResponse.json({error: 'partner_file_size'}, {status: 413})
  const reader = request.body?.getReader()
  if (!reader) return NextResponse.json({error: 'partner_file_invalid'}, {status: 400})
  let size = 0
  const chunks: Buffer[] = []
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_PARTNER_BYTES) { await reader.cancel(); return NextResponse.json({error: 'partner_file_size'}, {status: 413}) }
      chunks.push(Buffer.from(part.value))
    }
    return NextResponse.json(await importPartners({storeId: auth.user.storeId, connectionId: params.id}, Buffer.concat(chunks), auth.user))
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof IntegrationInputError) return NextResponse.json({error: error.code}, {status: error.status})
    throw error
  } finally { reader.releaseLock() }
}
