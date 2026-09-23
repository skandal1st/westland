import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { prisma } from '@/lib/db'
import { NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { configureOrderDelivery, OrderDeliveryConfigSchema } from '@/lib/integrations/order-delivery'
import { IntegrationInputError } from '@/lib/integrations/errors'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const parsed = OrderDeliveryConfigSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  const store = await getActiveStore()
  try { return NextResponse.json(await configureOrderDelivery(store.id, params.id, parsed.data, auth.user)) }
  catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof IntegrationInputError) return NextResponse.json({ error: error.code }, { status: error.status })
    throw error
  }
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const source = await prisma.integrationConnection.findFirst({ where: { id: params.id, storeId: store.id, provider: 'ONE_C' } })
  if (!source) return NextResponse.json({ error: 'source_not_found' }, { status: 404 })
  const parsed = OrderDeliveryConfigSchema.safeParse((source.config as { saleExport?: unknown } | null)?.saleExport)
  const [pending, delivered, sequence] = await Promise.all([
    prisma.enterpriseDataDelivery.count({ where: { connectionId: source.id, receivedAt: null } }),
    prisma.enterpriseDataDelivery.count({ where: { connectionId: source.id, receivedAt: { not: null } } }),
    prisma.enterpriseDataSequence.findUnique({ where: { connectionId: source.id }, select: { value: true, prefix: true } }),
  ])
  return NextResponse.json({ environment: source.environment, config: parsed.success ? parsed.data : { enabled: false }, pending, delivered, numberPrefix: sequence?.prefix, prefixFrozen: Boolean(sequence), editable: auth.user.role === 'ADMIN' && source.sourceState !== 'RETIRED' })
}
