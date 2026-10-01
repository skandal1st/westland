import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { StoreRequisitesInputSchema } from '@/lib/invoices/requisites'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SettingsInputSchema = StoreRequisitesInputSchema.extend({ showOutOfStock: z.boolean() })

/** Store settings: seller requisites + city (the invoice fallback identity). */
export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const settings = await prisma.appSettings.findUnique({
    where: { storeId: store.id },
    select: { sellerRequisites: true, showOutOfStock: true },
  })
  return NextResponse.json({ requisites: settings?.sellerRequisites ?? {}, showOutOfStock: settings?.showOutOfStock ?? true })
}

export async function PUT(request: Request) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const parsed = SettingsInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  const { showOutOfStock, ...requisitesInput } = parsed.data
  const requisites = prune(requisitesInput)
  const stored = requisites as unknown as Prisma.InputJsonObject
  await prisma.appSettings.upsert({
    where: { storeId: store.id },
    update: { sellerRequisites: stored, showOutOfStock },
    create: { storeId: store.id, sellerRequisites: stored, showOutOfStock },
  })
  return NextResponse.json({ requisites, showOutOfStock })
}

/** Drop blank/empty values so a cleared field never looks filled in storage. */
function prune(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = prune(value as Record<string, unknown>)
      if (Object.keys(nested).length > 0) out[key] = nested
    } else {
      out[key] = value
    }
  }
  return out
}
