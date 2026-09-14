import { getServerSession } from 'next-auth'
import { NextResponse } from 'next/server'
import { redirect } from 'next/navigation'
import type { UserRole } from '@prisma/client'
import { authOptions } from '@/lib/auth'

export type SessionUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>

export async function getCurrentUser() {
  const session = await getServerSession(authOptions)
  return session?.user ?? null
}

/**
 * API guard: returns the authenticated user or a ready-to-return 401/403
 * response. Backend enforcement of the closed catalog and staff actions relies
 * on this — never on the UI alone.
 */
export async function requireApiUser(
  roles?: UserRole[],
): Promise<{ user: SessionUser } | { response: NextResponse }> {
  const user = await getCurrentUser()
  if (!user) return { response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) }
  if (roles && !roles.includes(user.role)) {
    return { response: NextResponse.json({ error: 'forbidden' }, { status: 403 }) }
  }
  return { user }
}

export function isStaff(role: UserRole): boolean {
  return role === 'STAFF' || role === 'ADMIN'
}

/** Server-component guard: redirect anonymous users to login. */
export async function requireActiveUserPage(): Promise<SessionUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  return user
}

/** Server-component guard for the back office. */
export async function requireStaffPage(): Promise<SessionUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!isStaff(user.role)) redirect('/')
  return user
}
