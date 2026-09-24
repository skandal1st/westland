import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { createBuyerLocationForStaff, LocationError } from '@/lib/account/locations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(2000),
  city: z.string().trim().min(1).max(200),
  contactName: z.string().trim().max(200).optional(),
  contactPhone: z.string().trim().max(100).optional(),
  isDefault: z.boolean().optional(),
}).strict()

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'commerce-b2b')
  if ('response' in auth) return auth.response

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  if ((parsed.data.city + ', ' + parsed.data.address).length > 255) {
    return NextResponse.json({ error: 'address_too_long' }, { status: 400 })
  }

  try {
    const location = await createBuyerLocationForStaff(params.id, auth.user, parsed.data)
    return NextResponse.json({ id: location.id }, { status: 201 })
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof LocationError) {
      return NextResponse.json({ error: error.code }, { status: error.code === 'NOT_FOUND' ? 404 : 403 })
    }
    throw error
  }
}
