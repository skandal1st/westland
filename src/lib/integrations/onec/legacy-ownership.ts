import { Prisma, type PrismaClient } from '@prisma/client'
import { z } from 'zod'
import { fingerprint } from '@/lib/catalog/normalize'
import { recordAudit } from '@/lib/audit'
import { IntegrationInputError as InputError } from '@/lib/integrations/errors'
import { createOneCProvider } from './provider'
import type { ProviderPage } from '@/lib/integrations/provider'

const ids = z.array(z.string().min(1).max(200)).max(200_000)
export const OwnershipRequest = z.object({
  storeId: z.string().min(1), connectionId: z.string().min(1), generationId: z.string().min(1),
  selection: z.object({ priceIds: ids, stockIds: ids }).strict().optional(),
  mappings: z.array(z.object({ entityType: z.enum(['location', 'priceType']), externalId: z.string().min(1), entityId: z.string().min(1) }).strict()).max(1000).default([]),
}).strict()
type Request = z.infer<typeof OwnershipRequest>
type Tx = Prisma.TransactionClient
type Row = { kind: 'price' | 'stock'; id: string; variantId: string; targetId: string; version: string; before: Record<string, string | null> }
type Decision = { kind: Row['kind']; id: string; externalId: string; scopeKey: string; catalogDeleted: boolean }
type Blocker = { kind: string; id: string; code: string }
type Evidence = { catalog: Map<string, boolean>; prices: Map<string, { amount: number; currency: string }>; stocks: Map<string, number> }
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const hash = (value: unknown) => fingerprint(plain(value))
const key = (a: string, b: string) => JSON.stringify([a, b])
const unique = (values: string[]) => Array.from(new Set(values)).sort()
function request(value: unknown): Request {
  const r = OwnershipRequest.parse(value)
  if (r.selection) r.selection = { priceIds: unique(r.selection.priceIds), stockIds: unique(r.selection.stockIds) }
  r.mappings.sort((a, b) => key(a.entityType, a.externalId).localeCompare(key(b.entityType, b.externalId)))
  if (new Set(r.mappings.map(m => key(m.entityType, m.externalId))).size !== r.mappings.length) throw new InputError('ownership_duplicate_mapping')
  return r
}
async function evidence(r: Request): Promise<Evidence> {
  const provider = createOneCProvider(r.connectionId, r.generationId)
  const result: Evidence = { catalog: new Map(), prices: new Map(), stocks: new Map() }
  async function collect(pull: (cursor?: string) => Promise<ProviderPage>, consume: (row: any) => void) {
    let cursor: string | undefined
    do { const page = await pull(cursor); page.items.forEach(consume); cursor = page.nextCursor } while (cursor)
  }
  await collect(c => provider.pullProducts(c), p => {
    if (result.catalog.has(p.externalId)) throw new InputError('duplicate_product_identity')
    result.catalog.set(p.externalId, Boolean(p.deleted))
  })
  await collect(c => provider.pullPrices!(c), p => {
    if (p.deleted) return
    const k = key(p.externalId, p.priceTypeId)
    if (result.prices.has(k)) throw new InputError('duplicate_source_value')
    result.prices.set(k, { amount: p.amount, currency: p.currency })
  })
  await collect(c => provider.pullAvailability!(c), p => {
    if (p.deleted) return
    const k = key(p.externalId, p.locationCode)
    if (result.stocks.has(k)) throw new InputError('duplicate_source_value')
    result.stocks.set(k, p.available)
  })
  return result
}
async function versions(tx: Tx, table: 'PriceEntry' | 'Stock', rowIds: string[]) {
  const rows = await tx.$queryRaw<Array<{ id: string; version: string }>>(Prisma.sql`SELECT id, xmin::text AS version FROM ${Prisma.raw('"' + table + '"')}
    WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(rowIds)}::jsonb))`)
  return new Map(rows.map(r => [r.id, r.version]))
}
async function readState(tx: Tx, r: Request) {
  const source = await tx.integrationConnection.findFirst({ where: { id: r.connectionId, storeId: r.storeId, provider: 'ONE_C' },
    select: { id: true, storeId: true, provider: true, environment: true, sourceState: true, enabled: true, exchangeRevision: true, updatedAt: true } })
  if (!source || !source.enabled || source.sourceState !== 'ACTIVE') throw new InputError('ownership_source_inactive')
  const generation = await tx.onecGeneration.findFirst({ where: { id: r.generationId, connectionId: r.connectionId, sourceRevision: source.exchangeRevision }, select: { id: true, connectionId: true, sourceRevision: true, files: true } })
  if (!generation) throw new InputError('import_generation_mismatch')
  const mappings = await tx.externalReference.findMany({ where: { connectionId: r.connectionId, entityType: { in: ['product', 'location', 'priceType'] } },
    select: { id: true, entityType: true, externalId: true, entityId: true, updatedAt: true }, orderBy: { id: 'asc' } })
  const productIds = mappings.filter(m => m.entityType === 'product').map(m => m.entityId)
  const products = await tx.product.findMany({ where: { id: { in: productIds }, storeId: r.storeId },
    select: { id: true, status: true, variants: { select: { id: true, storeId: true, isDefault: true, status: true, sku: true, sourceSku: true }, orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } })
  const foreign = await tx.externalReference.findMany({ where: { entityType: 'product', entityId: { in: productIds }, connectionId: { not: r.connectionId } }, select: { id: true, entityId: true, connectionId: true }, orderBy: { id: 'asc' } })
  const books = await tx.priceBook.findMany({ where: { storeId: r.storeId }, select: { id: true, code: true, currency: true, isDefault: true, updatedAt: true }, orderBy: { id: 'asc' } })
  const locations = await tx.inventoryLocation.findMany({ where: { storeId: r.storeId }, select: { id: true, code: true, name: true }, orderBy: { id: 'asc' } })
  const channels = await tx.fulfillmentChannel.findMany({ where: { storeId: r.storeId }, select: { id: true, code: true, inventoryLocationId: true, priceBookId: true, priceGroupId: true, paymentMethod: true, isActive: true, updatedAt: true }, orderBy: { id: 'asc' } })
  const where = { variant: { storeId: r.storeId, ...(r.selection ? {} : { productId: { in: productIds } }) } }
  async function selected<T extends { id: string }>(rowIds: string[] | undefined, fetch: (part?: string[]) => Promise<T[]>) {
    const all: T[] = []
    if (!rowIds) all.push(...await fetch())
    else for (let offset = 0; offset < rowIds.length; offset += 5000) all.push(...await fetch(rowIds.slice(offset, offset + 5000)))
    return all.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  }
  const prices = await selected(r.selection?.priceIds, part => tx.priceEntry.findMany({ where: { ...where, ...(part ? { id: { in: part } } : {}) } }))
  const stocks = await selected(r.selection?.stockIds, part => tx.stock.findMany({ where: { ...where, ...(part ? { id: { in: part } } : {}) } }))
  const pv = await versions(tx, 'PriceEntry', prices.map(p => p.id)), sv = await versions(tx, 'Stock', stocks.map(s => s.id))
  const rows: Row[] = [
    ...prices.map(p => ({ kind: 'price' as const, id: p.id, variantId: p.variantId, targetId: p.priceBookId, version: pv.get(p.id)!, before: plain(p) as unknown as Row['before'] })),
    ...stocks.map(s => ({ kind: 'stock' as const, id: s.id, variantId: s.variantId, targetId: s.locationId, version: sv.get(s.id)!, before: plain(s) as unknown as Row['before'] })),
  ]
  return { context: { source, generation, mappings, products, foreign, books, locations, channels }, rows }
}
type State = Awaited<ReturnType<typeof readState>>
export type OwnershipPlan = { schemaVersion: 1; request: Request; before: State; decisions: Decision[]; createMappings: Request['mappings']; blockers: Blocker[]; warnings: string[]; digest: string }
function planFor(r: Request, state: State, raw: Evidence): OwnershipPlan {
  const { context: c, rows } = state
  const selection = r.selection ?? { priceIds: rows.filter(v => v.kind === 'price').map(v => v.id), stockIds: rows.filter(v => v.kind === 'stock').map(v => v.id) }
  const blockers: Blocker[] = [], warnings: string[] = [], decisions: Decision[] = [], createMappings: Request['mappings'] = []
  const maps = c.mappings.map(m => ({ entityType: m.entityType, externalId: m.externalId, entityId: m.entityId }))
  for (const proposed of r.mappings) {
    const same = maps.find(m => m.entityType === proposed.entityType && m.externalId === proposed.externalId)
    const collision = maps.find(m => m.entityType === proposed.entityType && m.entityId === proposed.entityId && m.externalId !== proposed.externalId)
    const target = proposed.entityType === 'priceType' ? c.books.some(b => b.id === proposed.entityId) : c.locations.some(l => l.id === proposed.entityId)
    const sourceScope = Array.from(proposed.entityType === 'priceType' ? raw.prices.keys() : raw.stocks.keys()).some(k => JSON.parse(k)[1] === proposed.externalId)
    if (!sourceScope || !target || collision || (same && same.entityId !== proposed.entityId)) blockers.push({ kind: 'mapping', id: proposed.externalId, code: 'ownership_mapping_conflict' })
    else if (!same) { maps.push(proposed); createMappings.push(proposed) }
  }
  const identities = new Map<string, string>(), invalid = new Set<string>()
  const productRefs = new Map<string, typeof maps>(), scopeRefs = new Map<string, typeof maps>()
  for (const m of maps) {
    const index = m.entityType === 'product' ? productRefs : scopeRefs
    const k = m.entityType === 'product' ? m.entityId : key(m.entityType, m.entityId)
    index.set(k, [...(index.get(k) ?? []), m])
  }
  const foreignProducts = new Set(c.foreign.map(f => f.entityId))
  for (const product of c.products) {
    const refs = productRefs.get(product.id) ?? []
    const defaults = product.variants.filter(v => v.isDefault && v.storeId === r.storeId)
    const ambiguous = refs.length !== 1 || defaults.length !== 1 || foreignProducts.has(product.id)
    for (const variant of product.variants) {
      if (ambiguous || !variant.isDefault) invalid.add(variant.id)
      else identities.set(variant.id, refs[0].externalId)
    }
  }
  for (const [kind, selected] of [['price', selection.priceIds], ['stock', selection.stockIds]] as const) {
    const found = new Set(rows.filter(row => row.kind === kind).map(row => row.id))
    for (const id of selected) if (!found.has(id)) blockers.push({ kind, id, code: 'ownership_row_missing_or_foreign' })
  }
  for (const row of rows) {
    const fail = (code: string) => blockers.push({ kind: row.kind, id: row.id, code })
    if (row.before.sourceConnectionId !== null || row.before.sourceGenerationId !== null || row.before.sourceScopeKey !== null) { fail('ownership_already_owned'); continue }
    const externalId = identities.get(row.variantId)
    if (!externalId || invalid.has(row.variantId)) { fail('ownership_product_mapping'); continue }
    const matches = scopeRefs.get(key(row.kind === 'price' ? 'priceType' : 'location', row.targetId)) ?? []
    if (matches.length !== 1) { fail('ownership_scope_mapping'); continue }
    const scopeKey = matches[0].externalId, k = key(externalId, scopeKey)
    const value = row.kind === 'price' ? raw.prices.get(k)?.amount : raw.stocks.get(k)
    const book = c.books.find(b => b.id === row.targetId)
    const targetExists = row.kind === 'price' ? Boolean(book) : c.locations.some(l => l.id === row.targetId)
    if (!targetExists || !raw.catalog.has(externalId) || typeof value !== 'number' || !Number.isFinite(value) || !new Prisma.Decimal(row.before[row.kind === 'price' ? 'amount' : 'available']!).equals(value)
      || (row.kind === 'price' && (!raw.prices.get(k)?.currency || raw.prices.get(k)?.currency !== book?.currency))) { fail('ownership_source_value_mismatch'); continue }
    decisions.push({ kind: row.kind, id: row.id, externalId, scopeKey, catalogDeleted: raw.catalog.get(externalId)! })
  }
  for (const channel of c.channels) {
    if (!maps.some(m => m.entityType === 'location' && m.entityId === channel.inventoryLocationId)) warnings.push(`channel_warehouse_unmapped:${channel.code}`)
    if (!maps.some(m => m.entityType === 'priceType' && m.entityId === channel.priceBookId)) warnings.push(`channel_price_type_unmapped:${channel.code}`)
  }
  if (decisions.some(d => d.catalogDeleted)) warnings.push('catalog_tombstones_present: ownership does not reactivate products; a later catalog import may remove their values')
  const base = plain({ schemaVersion: 1 as const, request: { ...r, selection }, before: state, decisions, createMappings, blockers, warnings })
  return { ...base, digest: hash(base) }
}
export async function draftLegacyOwnership(input: unknown, db: PrismaClient): Promise<OwnershipPlan> {
  const r = request(input), raw = await evidence(r)
  return db.$transaction(async tx => planFor(r, await readState(tx, r), raw), { isolationLevel: 'RepeatableRead', timeout: 120_000 })
}
async function lock(tx: Tx) {
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'")
  // Rare maintenance operation: prevent uncoordinated imports, mapping edits and
  // row insertions between validation and the atomic batch update. Reads remain available.
  await tx.$executeRawUnsafe('LOCK TABLE "IntegrationConnection", "IntegrationJob", "SyncRun", "ExternalReference", "Product", "ProductVariant", "PriceBook", "InventoryLocation", "FulfillmentChannel", "PriceEntry", "Stock", "LegacyOwnershipBatch" IN SHARE ROW EXCLUSIVE MODE')
}
async function actor(tx: Tx, storeId: string, actorId: string) {
  const admin = await tx.user.findFirst({ where: { id: actorId, storeId, role: 'ADMIN', status: 'ACTIVE' }, select: { id: true, email: true } })
  if (!admin) throw new InputError('ownership_admin_required', 403)
  return admin
}
async function idle(tx: Tx, connectionId: string) {
  if (await tx.integrationJob.count({ where: { connectionId, status: 'RUNNING' } }) || await tx.syncRun.count({ where: { connectionId, status: 'RUNNING' } })) throw new InputError('source_jobs_pending')
}
function checkedPlan(value: unknown, confirmation: string): OwnershipPlan {
  const p = value as OwnershipPlan
  if (!p || p.schemaVersion !== 1 || typeof p.digest !== 'string') throw new InputError('ownership_invalid_plan')
  const { digest, ...body } = p
  if (confirmation !== digest || hash(body) !== digest) throw new InputError('ownership_digest_mismatch')
  request(p.request)
  return p
}
async function updateOwners(tx: Tx, plan: OwnershipPlan, rollback = false) {
  for (const kind of ['price', 'stock'] as const) {
    const selected = plan.decisions.filter(d => d.kind === kind)
    for (let offset = 0; offset < selected.length; offset += 2000) {
      const part = selected.slice(offset, offset + 2000)
      const count = await tx.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw(kind === 'price' ? '"PriceEntry"' : '"Stock"')} target
        SET "sourceConnectionId" = ${rollback ? null : plan.request.connectionId}, "sourceGenerationId" = ${rollback ? null : plan.request.generationId},
          "sourceScopeKey" = CASE WHEN ${rollback} THEN NULL ELSE chosen.scope END
        FROM jsonb_to_recordset(${JSON.stringify(part.map(p => ({ id: p.id, scope: p.scopeKey })))}::jsonb) AS chosen(id text, scope text)
        WHERE target.id = chosen.id`)
      if (count !== part.length) throw new InputError('ownership_row_count_changed')
    }
  }
}
const receipt = (batch: { id: string; digest: string; rolledBackAt: Date | null }) => ({ id: batch.id, digest: batch.digest, status: batch.rolledBackAt ? 'ROLLED_BACK' : 'APPLIED' })
export async function applyLegacyOwnership(value: unknown, confirmation: string, actorId: string, db: PrismaClient) {
  const plan = checkedPlan(value, confirmation), r = request(plan.request), raw = await evidence(r)
  return db.$transaction(async tx => {
    await lock(tx)
    const admin = await actor(tx, r.storeId, actorId); await idle(tx, r.connectionId)
    const current = await readState(tx, r)
    const existing = await tx.legacyOwnershipBatch.findUnique({ where: { digest: plan.digest } })
    if (existing) {
      if (existing.rolledBackAt) throw new InputError('ownership_plan_already_rolled_back')
      if (existing.afterHash !== hash(current)) throw new InputError('ownership_after_state_changed')
      return receipt(existing)
    }
    const fresh = planFor(r, current, raw)
    if (fresh.digest !== plan.digest) throw new InputError('ownership_plan_stale')
    if (fresh.blockers.length || !fresh.decisions.length) throw new InputError('ownership_plan_blocked')
    for (const mapping of fresh.createMappings) await tx.externalReference.create({ data: { connectionId: r.connectionId, ...mapping } })
    await updateOwners(tx, fresh)
    const batch = await tx.legacyOwnershipBatch.create({ data: { storeId: r.storeId, connectionId: r.connectionId, digest: fresh.digest, plan: plain(fresh) as unknown as Prisma.InputJsonValue, afterHash: hash(await readState(tx, r)) } })
    await recordAudit(tx, { storeId: r.storeId, actor: admin, action: 'LegacyOwnershipApplied', targetType: 'LegacyOwnershipBatch', targetId: batch.id, metadata: { digest: batch.digest, rows: fresh.decisions.length, mappings: fresh.createMappings.length } })
    return receipt(batch)
  }, { timeout: 120_000, maxWait: 10_000 })
}
export async function rollbackLegacyOwnership(batchId: string, confirmation: string, actorId: string, db: PrismaClient) {
  return db.$transaction(async tx => {
    await lock(tx)
    const batch = await tx.legacyOwnershipBatch.findUnique({ where: { id: batchId } })
    if (!batch || batch.digest !== confirmation) throw new InputError('ownership_digest_mismatch')
    const plan = checkedPlan(batch.plan, confirmation), r = request(plan.request)
    const admin = await actor(tx, r.storeId, actorId); await idle(tx, r.connectionId)
    if (batch.rolledBackAt) return receipt(batch)
    if (hash(await readState(tx, r)) !== batch.afterHash) throw new InputError('ownership_after_state_changed')
    // A later import of other rows can depend on a newly created mapping even
    // when this batch's rows were untouched. Never remove that mapping then.
    for (const m of plan.createMappings) {
      const where = { sourceConnectionId: r.connectionId, sourceScopeKey: m.externalId, id: { notIn: plan.decisions.filter(d => d.kind === (m.entityType === 'priceType' ? 'price' : 'stock')).map(d => d.id) } }
      if (m.entityType === 'priceType' ? await tx.priceEntry.count({ where }) : await tx.stock.count({ where })) throw new InputError('ownership_mapping_in_use')
    }
    await updateOwners(tx, plan, true)
    for (const m of plan.createMappings) await tx.externalReference.delete({ where: { connectionId_entityType_externalId: { connectionId: r.connectionId, entityType: m.entityType, externalId: m.externalId } } })
    const updated = await tx.legacyOwnershipBatch.update({ where: { id: batchId }, data: { rolledBackAt: new Date() } })
    await recordAudit(tx, { storeId: r.storeId, actor: admin, action: 'LegacyOwnershipRolledBack', targetType: 'LegacyOwnershipBatch', targetId: batch.id, metadata: { digest: batch.digest, rows: plan.decisions.length, mappings: plan.createMappings.length } })
    return receipt(updated)
  }, { timeout: 120_000, maxWait: 10_000 })
}
