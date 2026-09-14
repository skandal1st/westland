import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { rejectRegistration, RegistrationError } from '@/lib/registration'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({ comment: z.string().max(500).optional() })

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response

  const body = await request.json().catch(() => ({}))
  const parsed = schema.safeParse(body ?? {})
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })

  try {
    await rejectRegistration(params.id, { actor: auth.user, comment: parsed.data.comment })
    return NextResponse.json({ status: 'rejected' })
  } catch (error) {
    if (error instanceof RegistrationError) {
      return NextResponse.json({ error: error.code }, { status: error.code === 'NOT_FOUND' ? 404 : 409 })
    }
    throw error
  }
}
