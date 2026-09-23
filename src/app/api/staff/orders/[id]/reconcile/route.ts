import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { reconcileOrder, OrderError } from '@/lib/orders/orders'
import { getProvider } from '@/lib/integrations/registry'
import { requireActiveSource, SourceProfileError } from '@/lib/integrations/sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const order = await prisma.order.findFirst({ where: { id: params.id, storeId: store.id }, select: { id: true, export: { select: { connectionId: true } } } })
  if (!order) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const connectionId = order.export?.connectionId
  if (!connectionId) return NextResponse.json({ error: 'not_exported' }, { status: 409 })

  const connection = await prisma.integrationConnection.findUnique({ where: { id: connectionId } })
  if (!connection) return NextResponse.json({ error: 'connection_missing' }, { status: 409 })

  try {
    await requireActiveSource(connection.id, store.id)
    const result = await reconcileOrder({ storeId: store.id, orderId: order.id, provider: getProvider(connection), actor: auth.user })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof SourceProfileError) return NextResponse.json({ error: error.code }, { status: 409 })
    if (error instanceof OrderError) return NextResponse.json({ error: error.code }, { status: 409 })
    throw error
  }
}
