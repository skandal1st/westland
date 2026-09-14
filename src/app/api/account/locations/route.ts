import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/authz'
import { createBuyerLocation, listBuyerLocations, LocationError } from '@/lib/account/locations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  return NextResponse.json({ locations: await listBuyerLocations(user) })
}

const schema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  city: z.string().min(1),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  isDefault: z.boolean().optional(),
})

export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  try {
    const location = await createBuyerLocation(user, parsed.data)
    return NextResponse.json({ id: location.id }, { status: 201 })
  } catch (error) {
    if (error instanceof LocationError) return NextResponse.json({ error: error.code }, { status: 403 })
    throw error
  }
}
