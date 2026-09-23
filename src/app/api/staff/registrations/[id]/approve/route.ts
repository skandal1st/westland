import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { approveRegistration, RegistrationError } from '@/lib/registration'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({ priceGroupId: z.string().optional(), locationIds: z.array(z.string().min(1)).max(200).default([]) }).strict()

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'commerce-b2b')
  if ('response' in auth) return auth.response

  const body = await request.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })

  try {
    await approveRegistration(params.id, { actor: auth.user, priceGroupId: parsed.data.priceGroupId, locationIds: parsed.data.locationIds })
    return NextResponse.json({ status: 'approved' })
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof RegistrationError) {
      return NextResponse.json({ error: error.code }, { status: error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 409 })
    }
    throw error
  }
}
