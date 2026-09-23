import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { deliveryAccess } from '@/lib/account/location-access'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/authz'
import { createBuyerLocation, listBuyerLocations, LocationError } from '@/lib/account/locations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const [locations, access] = await Promise.all([listBuyerLocations(user), deliveryAccess(user)])
  return NextResponse.json({ locations, canCreate: !!access })
}

const schema = z.object({
  name: z.string().trim().min(1),
  address: z.string().trim().min(1),
  city: z.string().trim().min(1),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  isDefault: z.boolean().optional(),
})

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  if ((parsed.data.city + ', ' + parsed.data.address).length > 255) {
    return NextResponse.json({ error: 'address_too_long' }, { status: 400 })
  }
  try {
    const location = await createBuyerLocation(user, parsed.data)
    return NextResponse.json({ id: location.id }, { status: 201 })
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof LocationError) return NextResponse.json({ error: error.code }, { status: 403 })
    throw error
  }
}
