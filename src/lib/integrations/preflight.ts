import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma as db } from '@/lib/db'
import { fingerprint } from '@/lib/catalog/normalize'
import { allocateSourceSku } from '@/lib/catalog/source-sku'
import { SellerRequisitesSchema } from '@/lib/invoices/requisites'
import { ChannelMappingSchema } from './mappings'
import { IntegrationInputError } from './errors'
import { publicSource } from './sources'
import { readSourcePreview } from './onec/preview'
import type { UploadFile } from './onec/storage'

type Issue = { code: string; count: number; examples: string[] }
type ProductChange = { externalId: string; sourceSku: string; internalSku: string | null; productId: string | null; change: 'new' | 'changed' | 'unchanged' | 'deleted' | 'absent'; name: string }

/** A point-in-time advisory report, never an activation token or an import. */
export async function previewSourceTransition(storeId: string, connectionId: string, generationId: string | undefined, client: PrismaClient = db) {
  return client.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
    const source = await tx.integrationConnection.findFirst({ where: { id: connectionId, storeId, provider: 'ONE_C' } })
    if (!source) throw new IntegrationInputError('source_not_found', 404)
    const checkedAt = new Date()
    const blockers = new Map<string, Issue>(), warnings = new Map<string, Issue>()
    function issue(code: string, example = '', warning = false, count = 1) {
      const target = warning ? warnings : blockers
      const row = target.get(code) ?? { code, count: 0, examples: [] }
      row.count += count
      if (example && row.examples.length < 20 && !row.examples.includes(example)) row.examples.push(example)
      target.set(code, row)
    }
    if (source.sourceState !== 'PREPARING' || source.enabled) issue('candidate_not_preparing')
    if (source.environment === 'UNCLASSIFIED') issue('source_environment_required')
    const connections = await tx.integrationConnection.findMany({ where: { storeId }, orderBy: { id: 'asc' } })
    const active = connections.find(c => c.sourceState === 'ACTIVE' && c.enabled)
    const refs = await tx.externalReference.findMany({ where: { connection: { storeId } }, orderBy: { id: 'asc' } })
    const ownRefs = refs.filter(r => r.connectionId === connectionId)
    const ref = (type: string, externalId: string) => ownRefsByKey.get(JSON.stringify([type, externalId]))
    const ownRefsByKey = new Map(ownRefs.map(r => [JSON.stringify([r.entityType, r.externalId]), r]))
    const [products, locations, books, channels, customers] = await Promise.all([
      tx.product.findMany({ where: { storeId }, include: { variants: true }, orderBy: { id: 'asc' } }),
      tx.inventoryLocation.findMany({ where: { storeId }, orderBy: { id: 'asc' } }),
      tx.priceBook.findMany({ where: { storeId }, orderBy: { id: 'asc' } }),
      tx.fulfillmentChannel.findMany({ where: { storeId }, orderBy: { id: 'asc' } }),
      tx.customer.findMany({ where: { storeId }, select: { id: true } }),
    ])
    const productById = new Map(products.map(p => [p.id, p]))
    const locationById = new Map(locations.map(l => [l.id, l]))
    const bookById = new Map(books.map(b => [b.id, b]))
    const channelById = new Map(channels.map(c => [c.id, c]))
    const customerIds = new Set(customers.map(c => c.id))
    const ownProductIds = ownRefs.filter(r => r.entityType === 'product').map(r => r.entityId)
    const foreign = ownProductIds.length ? await tx.externalReference.findMany({ where: {
      entityType: 'product', entityId: { in: ownProductIds }, connectionId: { not: connectionId },
    }, select: { entityId: true } }) : []
    const foreignProducts = new Set(foreign.map(r => r.entityId))
    for (const mapping of ownRefs) {
      const valid = mapping.entityType === 'product' ? productById.has(mapping.entityId)
        : mapping.entityType === 'location' ? locationById.has(mapping.entityId)
        : mapping.entityType === 'priceType' ? bookById.has(mapping.entityId)
        : mapping.entityType === 'customer' ? customerIds.has(mapping.entityId)
        : ['seller', 'channel'].includes(mapping.entityType) ? channelById.has(mapping.entityId) : true
      if (!valid) issue('mapping_target_not_found', mapping.entityType + ':' + mapping.externalId)
      if (mapping.entityType === 'product' && foreignProducts.has(mapping.entityId)) issue('product_source_conflict', mapping.externalId)
      if (mapping.entityType === 'seller' && !SellerRequisitesSchema.safeParse(mapping.sourceData).success) issue('seller_requisites_invalid', mapping.externalId)
    }
    const channelReport = channels.filter(c => c.isActive).map(c => {
      const parsed = ChannelMappingSchema.safeParse(ref('channel', c.id)?.sourceData)
      if (!parsed.success || parsed.data.channelId !== c.id || ref('channel', c.id)?.entityId !== c.id) {
        issue('channel_mapping_missing', c.id); return { id: c.id, code: c.code, ready: false }
      }
      const data = parsed.data, seller = ref('seller', data.sellerExternalId)
      const location = ref('location', data.warehouseExternalId), book = ref('priceType', data.priceTypeExternalId)
      const ready = Boolean(location && locationById.has(location.entityId) && book && bookById.has(book.entityId)
        && seller?.entityId === c.id && SellerRequisitesSchema.safeParse(seller?.sourceData).success)
      if (!ready) issue('channel_mappings_incomplete', c.id)
      return { id: c.id, code: c.code, ready, warehouseExternalId: data.warehouseExternalId, priceTypeExternalId: data.priceTypeExternalId,
        sellerExternalId: data.sellerExternalId, locationId: location?.entityId, priceBookId: book?.entityId }
    })
    if (!channelReport.length) issue('active_channels_missing')
    const [jobs, runs, checkpoints, orders, exports, prices, stocks, sessions] = await Promise.all([
      tx.integrationJob.findMany({ where: { storeId, status: { in: ['PENDING', 'RUNNING', 'RETRYING', 'FAILED', 'PARTIAL'] } }, select: { id: true, connectionId: true, generationId: true, status: true }, orderBy: { id: 'asc' } }),
      tx.syncRun.findMany({ where: { connection: { storeId }, status: { in: ['PENDING', 'RUNNING'] } }, select: { id: true, connectionId: true, status: true }, orderBy: { id: 'asc' } }),
      tx.syncCheckpoint.findMany({ where: { connection: { storeId }, completed: false }, select: { id: true, connectionId: true, generationId: true, entityType: true }, orderBy: { id: 'asc' } }),
      tx.order.findMany({ where: { storeId, status: { notIn: ['COMPLETED', 'CANCELLED', 'REJECTED'] } }, select: { id: true, number: true, status: true, export: { select: { connectionId: true, status: true } } }, orderBy: { id: 'asc' } }),
      tx.orderExport.findMany({ where: { storeId, status: { not: 'SUCCESS' } }, select: { id: true, orderId: true, connectionId: true, status: true }, orderBy: { id: 'asc' } }),
      tx.priceEntry.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } }),
      tx.stock.findMany({ where: { variant: { storeId } }, orderBy: { id: 'asc' } }),
      tx.onecExchangeSession.findMany({ where: { connectionId, sourceRevision: source.exchangeRevision }, select: { id: true, files: true, closedAt: true, expiresAt: true }, orderBy: { id: 'asc' } }),
    ])
    for (const [code, rows] of [['unfinished_jobs', jobs], ['unfinished_runs', runs], ['unfinished_checkpoints', checkpoints], ['unfinished_orders', orders], ['unfinished_exports', exports]] as const) {
      if (rows.length) issue(code, rows.slice(0, 20).map(r => r.id).join(', '), false, rows.length)
    }
    const partialUploads = sessions.filter(s => { const files = s.files as unknown as UploadFile[]; return files.some(f => !f.sealedAt) })
    const incompleteUploads = partialUploads.filter(s => !s.closedAt && s.expiresAt > checkedAt)
    const expiredUploads = partialUploads.filter(s => s.expiresAt <= checkedAt)
    if (expiredUploads.length) issue('expired_incomplete_uploads', '', true, expiredUploads.length)
    if (incompleteUploads.length) issue('incomplete_uploads', incompleteUploads.map(s => s.id).slice(0, 20).join(', '), false, incompleteUploads.length)
    const priceByKey = new Map(prices.map(p => [JSON.stringify([p.variantId, p.priceBookId]), p]))
    const stockByKey = new Map(stocks.map(s => [JSON.stringify([s.variantId, s.locationId]), s]))
    const generation = generationId ? await tx.onecGeneration.findFirst({ where: { id: generationId, connectionId } }) : null
    let parsed: Awaited<ReturnType<typeof readSourcePreview>> | null = null
    if (!generationId) issue('generation_required')
    else if (!generation || generation.sourceRevision !== source.exchangeRevision) issue('generation_source_changed')
    else {
      try { parsed = await readSourcePreview(connectionId, generation) }
      catch (error) {
        // Parser/FS messages may contain XML or private paths; expose stable codes only.
        issue(error instanceof IntegrationInputError ? error.code : 'generation_unreadable_or_invalid')
      }
    }
    const changes: ProductChange[] = []
    const collisions: { externalId: string; kind: 'sku' | 'externalId'; localId: string; otherSourceId: string | null }[] = []
    const valueReport: { externalId: string; kind: 'price' | 'stock'; scope: string; targetId: string | null; before: string | null; after: string; available?: string }[] = []
    if (parsed) {
      if (!parsed.files.some(f => f.kind === 'catalog') || !parsed.files.some(f => f.kind === 'offers')) issue('generation_streams_incomplete')
      if (parsed.catalog.mode !== 'full' || parsed.values.mode !== 'full') issue('full_generation_required')
      if (!parsed.values.priceTypes.length || !parsed.values.warehouses.length) issue('full_scope_required')
      if (!parsed.catalog.sourceUpdatedAt || !parsed.values.sourceUpdatedAt) issue('source_timestamp_unknown', '', true)
      if (parsed.catalog.sourceUpdatedAt && parsed.values.sourceUpdatedAt && parsed.catalog.sourceUpdatedAt !== parsed.values.sourceUpdatedAt) issue('generation_timestamps_differ', '', true)
      for (const key of parsed.values.priceTypes) if (!ref('priceType', key)) issue('price_type_unmapped', key)
      for (const key of parsed.values.warehouses) if (!ref('location', key)) issue('warehouse_unmapped', key)
      for (const c of channelReport) if (c.ready && (!parsed.values.priceTypes.includes(c.priceTypeExternalId!) || !parsed.values.warehouses.includes(c.warehouseExternalId!))) issue('channel_scope_missing', c.code)
      const occupied = new Map(products.flatMap(p => p.variants.map(v => [v.sku, { id: v.id, productId: p.id }] as const)))
      const foreignByExternal = new Map<string, typeof refs>()
      for (const r of refs) if (r.entityType === 'product' && r.connectionId !== connectionId) foreignByExternal.set(r.externalId, [...(foreignByExternal.get(r.externalId) ?? []), r])
      const seen = new Set<string>(), catalog = new Map(parsed.products.map(p => [p.externalId, p]))
      const variantByExternal = new Map<string, string>()
      for (const raw of [...parsed.products].sort((a, b) => a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0)) {
        if (seen.has(raw.externalId)) { issue('duplicate_product_identity', raw.externalId); continue }
        seen.add(raw.externalId)
        const mapping = ref('product', raw.externalId), current = mapping ? productById.get(mapping.entityId) : undefined
        const defaults = current?.variants.filter(v => v.isDefault) ?? []
        if (current && (defaults.length > 1 || (!defaults.length && current.variants.length))) issue('variant_identity_ambiguous', raw.externalId)
        const variant = defaults[0]
        if (variant) variantByExternal.set(raw.externalId, variant.id)
        for (const other of foreignByExternal.get(raw.externalId) ?? []) collisions.push({ externalId: raw.externalId, kind: 'externalId', localId: other.entityId, otherSourceId: other.connectionId })
        let internalSku: string | null = variant?.sku ?? null
        if (!raw.deleted) {
          const owner = occupied.get(raw.sku)
          if (owner && owner.id !== variant?.id) collisions.push({ externalId: raw.externalId, kind: 'sku', localId: owner.productId, otherSourceId: null })
          try {
            internalSku = allocateSourceSku({ connectionId, externalId: raw.externalId, sourceSku: raw.sku, currentSku: variant?.sku, occupied: sku => occupied.has(sku) })
            occupied.set(internalSku, { id: variant?.id ?? raw.externalId, productId: current?.id ?? raw.externalId })
          } catch { issue('source_identity_sku_conflict', raw.externalId) }
        }
        changes.push({ externalId: raw.externalId, sourceSku: raw.sku, internalSku, productId: current?.id ?? null, name: raw.name,
          change: raw.deleted ? 'deleted' : !current ? 'new' : current.status !== 'ACTIVE' || variant?.status !== 'ACTIVE' || current.canonicalName !== raw.name
            || variant?.sourceSku !== raw.sku || fingerprint(mapping?.sourceData) !== fingerprint(raw) ? 'changed' : 'unchanged' })
      }
      for (const mapping of ownRefs.filter(r => r.entityType === 'product')) if (!seen.has(mapping.externalId)) changes.push({
        externalId: mapping.externalId, sourceSku: '', internalSku: null, productId: mapping.entityId, name: productById.get(mapping.entityId)?.canonicalName ?? '', change: 'absent',
      })
      const seenOffers = new Set<string>(), tuples = new Set<string>()
      for (const offer of parsed.offers) {
        if (seenOffers.has(offer.externalId)) issue('duplicate_offer_identity', offer.externalId)
        seenOffers.add(offer.externalId)
        if (catalog.get(offer.externalId)?.deleted) { issue('catalog_tombstone_precedes_offer', offer.externalId, true); continue }
        if (offer.deleted) continue
        if (!catalog.has(offer.externalId)) issue('offer_product_missing_from_catalog', offer.externalId)
        const variantId = variantByExternal.get(offer.externalId)
        for (const kind of ['price', 'stock'] as const) {
          const rows = kind === 'price' ? offer.prices.map(p => ({ scope: p.priceTypeId, amount: p.amount, currency: p.currency }))
            : offer.warehouses.map(w => ({ scope: w.id, amount: w.qty, currency: '' }))
          for (const row of rows) {
            const mapping = ref(kind === 'price' ? 'priceType' : 'location', row.scope)
            const scope = kind === 'price' ? parsed.values.priceTypes : parsed.values.warehouses
            if (!mapping) issue(kind === 'price' ? 'price_type_unmapped' : 'warehouse_unmapped', row.scope)
            if (!scope.includes(row.scope)) issue('value_outside_full_scope', row.scope)
            const key = JSON.stringify([kind, offer.externalId, mapping?.entityId ?? row.scope])
            if (tuples.has(key)) issue('duplicate_source_value', offer.externalId + ':' + row.scope)
            tuples.add(key)
            if (!Number.isFinite(row.amount) || (kind === 'price' && row.amount < 0)) { issue('invalid_source_number', offer.externalId); continue }
            const amount = new Prisma.Decimal(String(row.amount)), scale = kind === 'price' ? 2 : 3
            if (amount.decimalPlaces() > scale || !Number.isSafeInteger(Math.round(row.amount * 10 ** scale))) issue('source_number_precision', offer.externalId)
            if (kind === 'price' && (!row.currency || row.currency !== bookById.get(mapping?.entityId ?? '')?.currency)) issue('price_currency_mismatch', offer.externalId)
            const valueKey = JSON.stringify([variantId, mapping?.entityId])
            const previous = kind === 'price' ? priceByKey.get(valueKey) : stockByKey.get(valueKey)
            if (previous && previous.sourceConnectionId !== connectionId) issue(kind === 'price' ? 'price_source_conflict' : 'stock_source_conflict', previous.id)
            valueReport.push({ externalId: offer.externalId, kind, scope: row.scope, targetId: mapping?.entityId ?? null,
              before: previous ? ('amount' in previous ? previous.amount : previous.available).toString() : null,
              after: amount.toString(), ...(kind === 'stock' ? { available: Prisma.Decimal.max(0, amount).toString() } : {}) })
          }
        }
      }
      // Full cleanup would touch absent tuples too, so ownership must be checked over the entire scope.
      const variantIds = new Set(variantByExternal.values())
      const bookIds = new Set(parsed.values.priceTypes.map(k => ref('priceType', k)?.entityId))
      const locationIds = new Set(parsed.values.warehouses.map(k => ref('location', k)?.entityId))
      for (const p of prices) if (variantIds.has(p.variantId) && bookIds.has(p.priceBookId) && p.sourceConnectionId !== connectionId) issue('price_source_conflict', p.id)
      for (const s of stocks) if (variantIds.has(s.variantId) && locationIds.has(s.locationId) && s.sourceConnectionId !== connectionId) issue('stock_source_conflict', s.id)
      if (collisions.length) issue('identities_kept_separate', '', true, collisions.length)
    }
    const environmentOf = (id: string | null) => connections.find(c => c.id === id)?.environment ?? 'UNOWNED'
    const existingData = connections.map(c => ({
      connectionId: c.id, environment: c.environment, sourceState: c.sourceState,
      products: refs.filter(r => r.connectionId === c.id && r.entityType === 'product').length,
      prices: prices.filter(p => p.sourceConnectionId === c.id).length, stocks: stocks.filter(s => s.sourceConnectionId === c.id).length,
    }))
    const report = {
      version: 1, source: publicSource(source), activeSource: active ? publicSource(active) : null,
      generation: generation ? { id: generation.id, digest: generation.digest, revision: generation.sourceRevision } : null,
      dataReady: blockers.size === 0, activationAllowed: false as const,
      activationRequirements: ['R05.5', 'R20', 'R23', 'backup', 'writers_stopped', 'fresh_preflight'],
      blockers: Array.from(blockers.values()), warnings: Array.from(warnings.values()),
      channels: channelReport, products: changes, collisions, values: valueReport,
      summary: { new: changes.filter(p => p.change === 'new').length, changed: changes.filter(p => p.change === 'changed').length,
        unchanged: changes.filter(p => p.change === 'unchanged').length, deleted: changes.filter(p => p.change === 'deleted' || p.change === 'absent').length,
        priceRows: valueReport.filter(v => v.kind === 'price').length, stockRows: valueReport.filter(v => v.kind === 'stock').length,
        negativeStocks: valueReport.filter(v => v.kind === 'stock' && new Prisma.Decimal(v.after).isNegative()).length },
      existingData, testData: { prices: prices.filter(p => environmentOf(p.sourceConnectionId) === 'TEST').length,
        stocks: stocks.filter(s => environmentOf(s.sourceConnectionId) === 'TEST').length },
      unowned: { prices: prices.filter(p => !p.sourceConnectionId).length, stocks: stocks.filter(s => !s.sourceConnectionId).length },
      pending: { jobs, runs, checkpoints, orders, exports },
      uploads: { sessions: sessions.length, open: sessions.filter(s => !s.closedAt).length },
      files: parsed?.files ?? [],
      metadata: parsed ? { catalog: parsed.catalog, values: parsed.values } : null,
    }
    // Digest binds the report to configuration AND live state. It is advisory; R05.5 must re-read everything.
    const contextDigest = fingerprint(JSON.parse(JSON.stringify({ sourceRevision: source.exchangeRevision, mappings: ownRefs, channels, books, locations,
      products, prices, stocks, jobs, runs, checkpoints, orders, exports, sessions, connections: connections.map(publicSource) })))
    return { ...report, contextDigest, digest: fingerprint({ report, contextDigest }), checkedAt: checkedAt.toISOString() }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 120_000, maxWait: 10_000 })
}

export type SourcePreflightReport = Awaited<ReturnType<typeof previewSourceTransition>>
