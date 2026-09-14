import { NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/authz'
import { reactivateUser, UserActionError } from '@/lib/users'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response

  try {
    await reactivateUser(params.id, { actor: auth.user })
    return NextResponse.json({ status: 'active' })
  } catch (error) {
    if (error instanceof UserActionError) {
      return NextResponse.json({ error: error.code }, { status: 404 })
    }
    throw error
  }
}
