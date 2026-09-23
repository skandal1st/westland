import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { prisma } from '@/lib/db'
import { resolveActiveSource } from '@/lib/integrations/sources'
import { saveSourceMapping } from '@/lib/integrations/mappings'
import { IntegrationInputError } from '@/lib/integrations/errors'
import { scanWarehouses } from '@/lib/integrations/onec/status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ENTITY = 'location'

async function onecConnectionId(storeId: string): Promise<string | null> {
  const c = await resolveActiveSource(storeId, 'ONE_C')
  return c?.id ?? null
}

/**
 * 1C warehouses from the offers files (GUID + stock) with their mapping to our
 * InventoryLocation (via ExternalReference), plus the locations available to map.
 */
export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const connectionId = await onecConnectionId(store.id)

  const [warehouses, locations, refs] = await Promise.all([
    connectionId ? scanWarehouses(connectionId) : Promise.resolve([]),
    prisma.inventoryLocation.findMany({ where: { storeId: store.id }, orderBy: { name: 'asc' }, select: { id: true, code: true, name: true } }),
    connectionId
      ? prisma.externalReference.findMany({ where: { connectionId, entityType: ENTITY }, select: { externalId: true, entityId: true } })
      : Promise.resolve([]),
  ])
  const locById = new Map(locations.map((l) => [l.id, l]))
  const mappedByGuid = new Map(refs.map((r) => [r.externalId, locById.get(r.entityId)?.name ?? null]))

  return NextResponse.json({
    hasConnection: Boolean(connectionId),
    connectionId,
    locations,
    warehouses: warehouses.map((w) => ({ ...w, mappedName: mappedByGuid.get(w.id) ?? null })),
  })
}

const mapSchema = z.object({ warehouseId: z.string().min(1), locationId: z.string().min(1) })

/** Map a 1C warehouse GUID to one of our InventoryLocations (ADMIN). */
export async function POST(request: Request) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const parsed = mapSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  const connectionId = await onecConnectionId(store.id)
  if (!connectionId) return NextResponse.json({ error: 'no_onec_connection' }, { status: 409 })

  const location = await prisma.inventoryLocation.findFirst({ where: { id: parsed.data.locationId, storeId: store.id }, select: { id: true } })
  if (!location) return NextResponse.json({ error: 'location_not_found' }, { status: 404 })

  try {
    await saveSourceMapping(store.id, connectionId, { entityType: 'location', externalId: parsed.data.warehouseId, entityId: location.id }, auth.user)
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof IntegrationInputError) return NextResponse.json({ error: error.code }, { status: error.status })
    throw error
  }
}
