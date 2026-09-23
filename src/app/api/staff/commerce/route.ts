import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { createInventoryLocation, createPriceBook, createPriceGroup, upsertFulfillmentChannel } from '@/lib/pricing/setup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const [locations, priceBooks, priceGroups, channels] = await Promise.all([
    prisma.inventoryLocation.findMany({ where: { storeId: store.id }, select: { id: true, code: true, name: true } }),
    prisma.priceBook.findMany({ where: { storeId: store.id }, select: { id: true, code: true, name: true, currency: true, isDefault: true } }),
    prisma.priceGroup.findMany({ where: { storeId: store.id }, select: { id: true, code: true, name: true, priceBookId: true } }),
    prisma.fulfillmentChannel.findMany({ where: { storeId: store.id }, orderBy: { sortOrder: 'asc' }, select: { id: true, code: true, name: true, paymentMethod: true, isActive: true, inventoryLocationId: true, priceBookId: true } }),
  ])
  return NextResponse.json({ locations, priceBooks, priceGroups, channels })
}

const schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('location'), code: z.string().min(1), name: z.string().min(1) }),
  z.object({ kind: z.literal('priceBook'), code: z.string().min(1), name: z.string().min(1), currency: z.string().optional(), isDefault: z.boolean().optional() }),
  z.object({ kind: z.literal('priceGroup'), code: z.string().min(1), name: z.string().min(1), priceBookId: z.string().optional() }),
  z.object({
    kind: z.literal('channel'), code: z.string().min(1), name: z.string().min(1),
    paymentMethod: z.enum(['BANK_TRANSFER', 'CASH']), inventoryLocationId: z.string().min(1),
    priceGroupId: z.string().optional(), priceBookId: z.string().optional(), isActive: z.boolean().optional(),
  }),
])

export async function POST(request: Request) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })
  const data = parsed.data
  if (data.kind === 'priceGroup') {
    const b2b = await requireApiUser(['ADMIN'], 'commerce-b2b')
    if ('response' in b2b) return b2b.response
  }

  if (data.kind === 'location') return NextResponse.json({ id: (await createInventoryLocation({ storeId: store.id, code: data.code, name: data.name })).id }, { status: 201 })
  if (data.kind === 'priceBook') return NextResponse.json({ id: (await createPriceBook({ storeId: store.id, code: data.code, name: data.name, currency: data.currency, isDefault: data.isDefault })).id }, { status: 201 })
  if (data.kind === 'priceGroup') return NextResponse.json({ id: (await createPriceGroup({ storeId: store.id, code: data.code, name: data.name, priceBookId: data.priceBookId })).id }, { status: 201 })
  const channel = await upsertFulfillmentChannel({
    storeId: store.id, code: data.code, name: data.name, paymentMethod: data.paymentMethod,
    inventoryLocationId: data.inventoryLocationId, priceGroupId: data.priceGroupId ?? null, priceBookId: data.priceBookId ?? null,
    isActive: data.isActive, actor: auth.user,
  })
  return NextResponse.json({ id: channel.id }, { status: 201 })
}
