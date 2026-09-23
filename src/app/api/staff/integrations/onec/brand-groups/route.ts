import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { setCategoryBrand, readBrandAssignments } from '@/lib/integrations/brand-management'
import { resolveActiveSource } from '@/lib/integrations/sources'
import { scanGroups } from '@/lib/integrations/onec/status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function onecConnection(storeId: string) {
  return resolveActiveSource(storeId, 'ONE_C')
}

function brandSetOf(config: Prisma.JsonValue | null): Set<string> {
  const raw = (config ?? {}) as Record<string, unknown>
  const list = Array.isArray(raw.brandGroups) ? raw.brandGroups : []
  return new Set(list.filter((x): x is string => typeof x === 'string'))
}

/** Full group tree + which groups are marked as brands (from connection.config). */
export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const connection = await onecConnection(store.id)
  const brands = connection ? brandSetOf(connection.config) : new Set<string>()

  const groups = connection ? await scanGroups(connection.id) : []
  const assignments = connection ? await readBrandAssignments(store.id, connection.id) : new Map()
  return NextResponse.json({
    hasConnection: Boolean(connection),
    connectionId: connection?.id ?? null,
    brandCount: brands.size,
    groups: groups.map((g) => ({ externalId: g.externalId, name: g.name, parentId: g.parentId, path: g.path, depth: g.depth, isBrand: brands.has(g.externalId), brand: brands.has(g.externalId) ? assignments.get(g.externalId) ?? null : null })),
  })
}

const schema = z.object({ externalId: z.string().min(1), isBrand: z.boolean() })

/** Mark / unmark a group as a brand (ADMIN); persisted in connection.config.brandGroups. */
export async function POST(request: Request) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core')
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 400 })
  const connection = await onecConnection(store.id)
  if (!connection) return NextResponse.json({ error: 'no_onec_connection' }, { status: 409 })

  try { return NextResponse.json(await setCategoryBrand(store.id, connection.id, parsed.data.externalId, parsed.data.isBrand, auth.user.id)) }
  catch (error) {
    if (error instanceof Error && ['source_changed', 'group_not_found'].includes(error.message)) return NextResponse.json({ error: error.message }, { status: 409 })
    throw error
  }
}
