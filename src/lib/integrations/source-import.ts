import { assertCapability } from '@/lib/capabilities'
import { Prisma, type PrismaClient } from '@prisma/client'
import type { OperationalProvider, ProviderPage } from './provider'
import { IntegrationInputError as InputError } from './errors'
import { applyProductBatch } from '@/lib/catalog/import-batch'
import { projectStoreAvailability } from '@/lib/pricing/availability'
import { applySourceValues, type SourceValue } from './source-value-batch'

type Tx = Prisma.TransactionClient
type Input = { storeId: string; connectionId: string; provider: OperationalProvider }
type Stream = 'catalog' | 'prices' | 'availability'
type Raw = { externalId: string; deleted?: boolean; priceTypeId?: string; currency?: string; amount?: number; locationCode?: string; available?: number }

async function collect(pull: (cursor?: string) => Promise<ProviderPage>) {
  let cursor: string | undefined, header: ProviderPage | undefined, pages = 0
  const items: Raw[] = [], cursors = new Set<string>()
  do {
    const page = await pull(cursor)
    if (header && (page.mode !== header.mode || JSON.stringify(page.scope) !== JSON.stringify(header.scope) || page.sourceUpdatedAt !== header.sourceUpdatedAt)) throw new InputError('page_contract_changed')
    header ??= page; items.push(...page.items as Raw[]); pages++
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) throw new InputError('cursor_cycle')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return { items, pages, mode: header!.mode ?? 'unknown', scope: header!.scope ?? [], sourceUpdatedAt: header!.sourceUpdatedAt ?? null }
}

async function authority(tx: Tx, input: Input, stream: Stream) {
  await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${input.connectionId} FOR UPDATE`
  const source = await tx.integrationConnection.findUnique({ where: { id: input.connectionId } })
  const generation = await tx.onecGeneration.findUnique({ where: { id: input.provider.generationId ?? '' } })
  if (!source || source.storeId !== input.storeId || source.provider !== 'ONE_C' || !source.enabled || source.sourceState !== 'ACTIVE' || input.provider.sourceId !== source.id || !generation || generation.connectionId !== source.id || generation.sourceRevision !== source.exchangeRevision) throw new InputError('import_generation_mismatch')
  const previous = await tx.syncCursor.findUnique({ where: { connectionId_entityType: { connectionId: source.id, entityType: `generation:${stream}` } } })
  if (previous?.cursor && previous.cursor !== generation.id) {
    const last = await tx.onecGeneration.findUnique({ where: { id: previous.cursor } })
    if (last && (last.createdAt > generation.createdAt || (last.createdAt.getTime() === generation.createdAt.getTime() && last.id > generation.id))) throw new InputError('older_generation_rejected')
  }
  return generation
}
async function markApplied(tx: Tx, input: Input, stream: Stream) {
  await tx.syncCursor.upsert({ where: { connectionId_entityType: { connectionId: input.connectionId, entityType: `generation:${stream}` } },
    create: { connectionId: input.connectionId, entityType: `generation:${stream}`, cursor: input.provider.generationId, lastSyncAt: new Date() },
    update: { cursor: input.provider.generationId, lastSyncAt: new Date(), lastError: null } })
}
async function variants(tx: Tx, input: Input) {
  const refs = await tx.externalReference.findMany({ where: { connectionId: input.connectionId, entityType: 'product' } })
  const products = await tx.product.findMany({ where: { id: { in: refs.map(r => r.entityId) }, storeId: input.storeId }, include: { variants: { where: { isDefault: true } } } })
  const byId = new Map(products.map(p => [p.id, p]))
  const result = new Map<string, { id: string; active: boolean }>()
  const others = await tx.externalReference.count({ where: { entityType: 'product', entityId: { in: refs.map(r => r.entityId) }, connectionId: { not: input.connectionId } } })
  if (others) throw new InputError('product_source_conflict')
  for (const ref of refs) {
    const product = byId.get(ref.entityId)
    if (!product || product.variants.length !== 1) throw new InputError('invalid_product_mapping')
    result.set(ref.externalId, { id: product.variants[0].id, active: product.status === 'ACTIVE' && product.variants[0].status === 'ACTIVE' })
  }
  return result
}

/** Immutable generation parsed outside the transaction; mutations and absence cleanup commit together. */
export async function importSourceCatalog(input: Input, client: PrismaClient) {
  assertCapability('commerce-core')

  const data = await collect(cursor => input.provider.pullProducts(cursor))
  if (new Set(data.items.map(i => i.externalId)).size !== data.items.length) throw new InputError('duplicate_product_identity')
  return client.$transaction(async tx => {
    await authority(tx, input, 'catalog')
    const cp = await tx.syncCheckpoint.findUnique({ where: { connectionId_entityType: { connectionId: input.connectionId, entityType: 'product' } } })
    if (cp && !cp.completed && cp.generationId !== input.provider.generationId) throw new InputError('checkpoint_generation_mismatch')
    const refs = await tx.externalReference.findMany({ where: { connectionId: input.connectionId, entityType: 'product' } })
    const current = new Map(refs.map(ref => [ref.externalId, ref.entityId]))
    const seen = new Set<string>(), archive = new Set<string>()
    for (const raw of data.items) {
      if (!raw.externalId) throw new InputError('invalid_product_identity')
      seen.add(raw.externalId)
      if (raw.deleted) { const id = current.get(raw.externalId); if (id) archive.add(id) }
    }
    const imported = await applyProductBatch({ storeId: input.storeId, connectionId: input.connectionId, payloads: data.items.filter(raw => !raw.deleted) }, tx)
    if (data.mode === 'full') for (const ref of refs) if (!seen.has(ref.externalId)) archive.add(ref.entityId)
    const ids = Array.from(archive)
    if (ids.length) {
      const foreign = await tx.externalReference.count({ where: { entityType: 'product', entityId: { in: ids }, connectionId: { not: input.connectionId } } })
      if (foreign) throw new InputError('product_source_conflict')
      await tx.product.updateMany({ where: { id: { in: ids }, storeId: input.storeId }, data: { status: 'ARCHIVED' } })
      await tx.productVariant.updateMany({ where: { productId: { in: ids }, storeId: input.storeId }, data: { status: 'ARCHIVED' } })
      const owned = { sourceConnectionId: input.connectionId, variant: { productId: { in: ids }, storeId: input.storeId } }
      await tx.priceEntry.deleteMany({ where: owned }); await tx.stock.deleteMany({ where: owned })
      await projectStoreAvailability(input.storeId, tx)
    }
    await tx.syncCheckpoint.upsert({ where: { connectionId_entityType: { connectionId: input.connectionId, entityType: 'product' } },
      create: { connectionId: input.connectionId, entityType: 'product', generationId: input.provider.generationId, completed: true, page: data.pages, processed: data.items.length },
      update: { generationId: input.provider.generationId, completed: true, failed: 0, cursor: null, page: data.pages, processed: data.items.length, lastExternalId: data.items.at(-1)?.externalId ?? null } })
    await markApplied(tx, input, 'catalog')
    return { pages: data.pages, imported, skipped: 0, failed: 0, ...(ids.length ? { removed: ids.length } : {}) }
  }, { timeout: 120_000, maxWait: 10_000 })
}

export async function importSourceValues(input: Input, stream: 'prices' | 'availability', client: PrismaClient) {
  assertCapability('commerce-core')

  const pull = stream === 'prices' ? input.provider.pullPrices : input.provider.pullAvailability
  if (!pull) throw new InputError('provider_stream_missing')
  const data = await collect(cursor => pull.call(input.provider, cursor))
  const catalog = await collect(cursor => input.provider.pullProducts(cursor))
  if (new Set(catalog.items.map(i => i.externalId)).size !== catalog.items.length) throw new InputError('duplicate_product_identity')
  const catalogDeleted = new Set(catalog.items.filter(i => i.deleted).map(i => i.externalId))
  return client.$transaction(async tx => {
    await authority(tx, input, stream)
    if (catalogDeleted.size) {
      const applied = await tx.syncCursor.findUnique({ where: { connectionId_entityType: { connectionId: input.connectionId, entityType: 'generation:catalog' } } })
      const checkpoint = await tx.syncCheckpoint.findUnique({ where: { connectionId_entityType: { connectionId: input.connectionId, entityType: 'product' } } })
      if (applied?.cursor !== input.provider.generationId || !checkpoint?.completed || checkpoint.generationId !== input.provider.generationId) throw new InputError('catalog_generation_not_applied')
    }
    const byExternal = await variants(tx, input)
    const refs = await tx.externalReference.findMany({ where: { connectionId: input.connectionId, entityType: stream === 'prices' ? 'priceType' : 'location' } })
    const mapping = new Map(refs.map(r => [r.externalId, r.entityId]))
    const books = new Map((await tx.priceBook.findMany({ where: { storeId: input.storeId } })).map(b => [b.id, b]))
    const locations = new Set((await tx.inventoryLocation.findMany({ where: { storeId: input.storeId } })).map(l => l.id))
    if (data.mode === 'full' && !data.scope.length) throw new InputError('full_scope_required')
    for (const key of data.scope) {
      const target = mapping.get(key)
      if (!target) throw new InputError(stream === 'prices' ? 'price_type_unmapped' : 'warehouse_unmapped')
      if (stream === 'prices' ? !books.has(target) : !locations.has(target)) throw new InputError('mapping_target_not_found')
    }
    if (data.mode === 'full') {
      const variantIds = Array.from(byExternal.values()).map(v => v.id)
      const targetIds = data.scope.map(key => mapping.get(key)!)
      const foreign = { variantId: { in: variantIds }, OR: [{ sourceConnectionId: null }, { sourceConnectionId: { not: input.connectionId } }] }
      const conflicts = stream === 'prices'
        ? await tx.priceEntry.count({ where: { ...foreign, priceBookId: { in: targetIds } } })
        : await tx.stock.count({ where: { ...foreign, locationId: { in: targetIds } } })
      if (conflicts) throw new InputError(stream === 'prices' ? 'price_source_conflict' : 'stock_source_conflict')
    }
    const deleted = new Set<string>(), keys = new Set<string>(), targets = new Set<string>()
    const rows: SourceValue[] = []
    const at = data.sourceUpdatedAt ? new Date(data.sourceUpdatedAt) : null
    if (at && !Number.isFinite(at.getTime())) throw new InputError('invalid_source_timestamp')
    let imported = 0, skipped = 0
    const reconciled = new Set<string>(), unknownDeleted = new Set<string>()
    for (const raw of data.items) {
      const variant = byExternal.get(raw.externalId)
      const variantId = variant?.id
      if (catalogDeleted.has(raw.externalId) || raw.deleted) {
        if (catalogDeleted.has(raw.externalId)) { reconciled.add(raw.externalId); skipped++ }
        if (variantId) deleted.add(variantId)
        else { unknownDeleted.add(raw.externalId); if (!catalogDeleted.has(raw.externalId)) skipped++ }
        continue
      }
      if (!variantId) throw new InputError('product_unmapped')
      if (!variant?.active) throw new InputError('product_archived')
      const scope = stream === 'prices' ? raw.priceTypeId : raw.locationCode
      const target = scope ? mapping.get(scope) : undefined
      if (!scope || !target) throw new InputError(stream === 'prices' ? 'price_type_unmapped' : 'warehouse_unmapped')
      if (data.mode === 'full' && !data.scope.includes(scope)) throw new InputError('value_outside_full_scope')
      const key = `${variantId}:${scope}`
      if (keys.has(key)) throw new InputError('duplicate_source_value')
      keys.add(key)
      const amount = stream === 'prices' ? raw.amount : raw.available
      if (typeof amount !== 'number' || !Number.isFinite(amount) || (stream === 'prices' && amount < 0)) throw new InputError('invalid_source_number')
      const scale = stream === 'prices' ? 2 : 3
      if (new Prisma.Decimal(String(amount)).decimalPlaces() > scale || !Number.isSafeInteger(Math.round(amount * 10 ** scale))) throw new InputError('source_number_precision')
      const targetKey = `${variantId}:${target}`
      if (targets.has(targetKey)) throw new InputError('duplicate_source_value')
      targets.add(targetKey)
      if (stream === 'prices') {
        const book = books.get(target)
        if (!book) throw new InputError('price_book_not_found')
        if (!raw.currency || raw.currency !== book.currency) throw new InputError('price_currency_mismatch')
      } else if (!locations.has(target)) throw new InputError('inventory_location_not_found')
      rows.push({ variantId, targetId: target, scope, amount })
      imported++
    }
    const removed = await applySourceValues(tx, { connectionId: input.connectionId, generationId: input.provider.generationId!, stream,
      rows, deleted: Array.from(deleted), fullScope: data.mode === 'full' ? data.scope : [], sourceUpdatedAt: at })
    if (stream === 'availability') await projectStoreAvailability(input.storeId, tx)
    await markApplied(tx, input, stream)
    return { imported, failed: 0, ...(removed ? { removed } : {}), ...(skipped ? { skipped } : {}), ...(reconciled.size ? { catalogDeleted: reconciled.size } : {}), ...(unknownDeleted.size ? { unknownDeleted: unknownDeleted.size } : {}) }
  }, { timeout: 120_000, maxWait: 10_000 })
}
