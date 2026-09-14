import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createRegistrationRequest, RegistrationError } from '@/lib/registration'
import { clientIp, rateLimit } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Пароль не короче 8 символов'),
  contactName: z.string().min(1),
  phone: z.string().optional(),
  legalName: z.string().min(1),
  inn: z.string().min(1),
  kpp: z.string().optional(),
})

const ERROR_STATUS: Record<RegistrationError['code'], number> = {
  EMAIL_TAKEN: 409,
  ALREADY_PENDING: 409,
  INVALID_INN: 422,
  NOT_FOUND: 404,
  NOT_PENDING: 409,
}

export async function POST(request: Request) {
  const limit = rateLimit(`register:${clientIp(request.headers)}`, 5, 60_000)
  if (!limit.ok) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) } })
  }

  const body = await request.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })
  }

  try {
    const result = await createRegistrationRequest(parsed.data)
    const status = result.status === 'APPROVED' ? 'active' : 'pending'
    return NextResponse.json({ status }, { status: 201 })
  } catch (error) {
    if (error instanceof RegistrationError) {
      return NextResponse.json({ error: error.code }, { status: ERROR_STATUS[error.code] })
    }
    logger.error('registration failed', { message: (error as Error).message })
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
