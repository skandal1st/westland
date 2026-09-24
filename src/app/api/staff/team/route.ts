import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { prisma } from '@/lib/db'
import { createStaffAccount, StaffAccountError } from '@/lib/staff-accounts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(200),
  role: z.enum(['STAFF', 'ADMIN']),
}).strict()

export async function GET() {
  const auth = await requireApiUser(['ADMIN'])
  if ('response' in auth) return auth.response

  const users = await prisma.user.findMany({
    where: { storeId: auth.user.storeId, role: { in: ['STAFF', 'ADMIN'] } },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, email: true, name: true, role: true, status: true, createdAt: true },
  })
  return NextResponse.json({ users }, { headers: { 'cache-control': 'private, no-store' } })
}

export async function POST(request: Request) {
  const auth = await requireApiUser(['ADMIN'])
  if ('response' in auth) return auth.response

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success || Buffer.byteLength(parsed.data.password, 'utf8') > 72) {
    return NextResponse.json({ error: 'INVALID_INPUT' }, { status: 400 })
  }

  try {
    const user = await createStaffAccount(auth.user, parsed.data)
    return NextResponse.json({ user }, { status: 201 })
  } catch (error) {
    if (error instanceof StaffAccountError) {
      const status = error.code === 'FORBIDDEN' ? 403 : error.code === 'EMAIL_EXISTS' ? 409 : 400
      return NextResponse.json({ error: error.code }, { status })
    }
    throw error
  }
}
