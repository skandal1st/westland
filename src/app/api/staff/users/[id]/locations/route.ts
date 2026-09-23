import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { DeliveryAccessError, setBuyerDeliveryPoints } from '@/lib/account/location-access'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const schema = z.object({ locationIds: z.array(z.string().min(1)).max(200) }).strict()
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'commerce-b2b')
  if ('response' in auth) return auth.response
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  try { return NextResponse.json(await setBuyerDeliveryPoints(params.id, parsed.data.locationIds, auth.user)) }
  catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof DeliveryAccessError) return NextResponse.json({ error: error.code }, { status: error.code === 'FORBIDDEN' ? 403 : error.code === 'NOT_FOUND' ? 404 : 400 })
    throw error
  }
}
