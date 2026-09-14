import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/authz'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ user: null }, { status: 401 })
  return NextResponse.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status },
  })
}
