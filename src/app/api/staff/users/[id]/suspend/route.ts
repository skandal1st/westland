import { NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/authz'
import { suspendUser, UserActionError } from '@/lib/users'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response

  try {
    await suspendUser(params.id, { actor: auth.user })
    return NextResponse.json({ status: 'suspended' })
  } catch (error) {
    if (error instanceof UserActionError) {
      return NextResponse.json({ error: error.code }, { status: error.code === 'NOT_FOUND' ? 404 : 409 })
    }
    throw error
  }
}
