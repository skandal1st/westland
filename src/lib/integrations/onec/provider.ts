import { parseCatalog, parseOffers, type OnecGroup, type OnecOffer, type OnecRawProduct } from '@/lib/integrations/onec/commerceml'
import type { OperationalProvider, ProviderPage } from '@/lib/integrations/provider'
import { parseExchangeMetadata, mergeMetadata, type ExchangeMetadata } from './metadata'
import { requireGeneration } from './ledger'
import { ExchangeError, readGenerationFile, type GenerationFile } from './storage'
const PAGE_SIZE = 500

type PriceRow = { externalId: string; priceTypeId?: string; amount?: number; currency?: string; deleted?: boolean }
type AvailabilityRow = { externalId: string; locationCode?: string; available?: number; deleted?: boolean }

/**
 * ONE_C OperationalProvider backed by the files 1C pushes via "Обмен с сайтом"
 * (sealed in an immutable, explicitly published generation). Catalog (products +
 * category tree) is read from import*.xml; the parser already resolves each
 * product's top-level category. Prices/stock (offers*.xml) arrive in a later
 * slice. The manifest may include either stream or both; no directory scanning or
 * latest-file fallback is allowed.
 */
/**
 * Nearest ancestor group (including the leaf) that staff marked as a brand.
 * Brands sit at inconsistent depths in 1C, so there is no rule — the mark wins.
 */
function brandFor(groupId: string | undefined, groups: Map<string, OnecGroup>, brandSet: Set<string>): { id: string; name: string } | null {
  let current = groupId
  const seen = new Set<string>()
  while (current && groups.has(current) && !seen.has(current)) {
    seen.add(current)
    if (brandSet.has(current)) return { id: current, name: groups.get(current)!.name }
    current = groups.get(current)!.parentId ?? undefined
  }
  return null
}

export function createOneCProvider(connectionId: string, generationId: string | undefined, brandGroups: Iterable<string> = []): OperationalProvider {
  let files: GenerationFile[] | null = null
  async function generationFiles(kind: 'catalog' | 'offers') {
    if (!generationId) throw new ExchangeError('generation_required')
    const generation = await requireGeneration(connectionId, generationId)
    files ??= generation.files as unknown as GenerationFile[]
    return files.filter(file => file.kind === kind)
  }
  const brandSet = new Set(brandGroups)
  let products: OnecRawProduct[] | null = null
  let groups: Map<string, OnecGroup> = new Map()
  let priced: PriceRow[] | null = null
  let catalogMeta: ExchangeMetadata, offersMeta: ExchangeMetadata
  let availability: AvailabilityRow[] | null = null

  async function ensureCatalog(): Promise<void> {
    if (products) return
    const accumulated: OnecRawProduct[] = []
    const merged = new Map<string, OnecGroup>()
    const metadata: ExchangeMetadata[] = []
    for (const file of await generationFiles('catalog')) {
      const xml = await readGenerationFile(connectionId, file)
      metadata.push(parseExchangeMetadata(xml, 'catalog'))
      const { groups: g } = parseCatalog(xml, (product) => accumulated.push(product))
      g.forEach((v, k) => merged.set(k, v))
    }
    catalogMeta = mergeMetadata(metadata)
    products = accumulated
    groups = merged
  }

  async function ensureOffers(): Promise<void> {
    if (priced && availability) return
    const offers: OnecOffer[] = []
    const metadata: ExchangeMetadata[] = []
    for (const file of await generationFiles('offers')) {
      const xml = await readGenerationFile(connectionId, file)
      metadata.push(parseExchangeMetadata(xml, 'offers'))
      parseOffers(xml, (offer) => offers.push(offer))
    }
    offersMeta = mergeMetadata(metadata)
    if (new Set(offers.map(o => o.externalId)).size !== offers.length) throw new ExchangeError('duplicate_offer_identity')
    priced = offers.flatMap<PriceRow>(o => o.deleted ? [{ externalId: o.externalId, deleted: true }] : o.prices.map(p => ({ externalId: o.externalId, ...p })))
    const rows: AvailabilityRow[] = []
    for (const offer of offers) {
      if (offer.deleted) { rows.push({ externalId: offer.externalId, deleted: true }); continue }
      for (const wh of offer.warehouses) rows.push({ externalId: offer.externalId, locationCode: wh.id, available: wh.qty })
    }
    availability = rows
  }

  function page<T>(all: T[], cursor?: string): { items: T[]; nextCursor?: string } {
    const offset = cursor ? Number(cursor) : 0
    const items = all.slice(offset, offset + PAGE_SIZE)
    const next = offset + PAGE_SIZE
    return { items, nextCursor: next < all.length ? String(next) : undefined }
  }

  return {
    provider: 'ONE_C',
    generationId,
    sourceId: connectionId,
    async healthcheck() {
      const catalog = await generationFiles('catalog')
      const offers = await generationFiles('offers')
      return { ok: catalog.length + offers.length > 0, message: `generation ${generationId}: ${catalog.length} catalog, ${offers.length} offers files` }
    },
    async pullProducts(cursor?: string): Promise<ProviderPage> {
      await generationFiles('catalog')
      await ensureCatalog()
      const { items, nextCursor } = page(products ?? [], cursor)
      return {
        items: items.map((p) => {
          const brand = brandSet.size > 0 ? brandFor(p.groupId, groups, brandSet) : null
          const brandPath: Array<{ id: string; name: string }> = []
          let current = p.groupId
          const seen = new Set<string>()
          while (current && groups.has(current) && !seen.has(current)) {
            seen.add(current)
            brandPath.push({ id: current, name: groups.get(current)!.name })
            current = groups.get(current)!.parentId ?? undefined
          }
          return { ...p, brandPath, ...(brand ? { brandExternalId: brand.id, brandName: brand.name } : {}) }
        }),
        nextCursor, mode: catalogMeta.mode, sourceUpdatedAt: catalogMeta.sourceUpdatedAt,
      }
    },
    async pullPrices(cursor?: string): Promise<ProviderPage> {
      await generationFiles('offers')
      await ensureOffers()
      const { items, nextCursor } = page(priced ?? [], cursor)
      return { items, nextCursor, mode: !offersMeta.priceTypes.length && !priced?.length && Boolean(availability?.length || offersMeta.warehouses.length) ? 'unknown' : offersMeta.mode, scope: offersMeta.priceTypes, sourceUpdatedAt: offersMeta.sourceUpdatedAt }
    },
    async pullAvailability(cursor?: string): Promise<ProviderPage> {
      await generationFiles('offers')
      await ensureOffers()
      const { items, nextCursor } = page(availability ?? [], cursor)
      return { items, nextCursor, mode: !offersMeta.warehouses.length && !availability?.length && Boolean(priced?.length || offersMeta.priceTypes.length) ? 'unknown' : offersMeta.mode, scope: offersMeta.warehouses, sourceUpdatedAt: offersMeta.sourceUpdatedAt }
    },
  }
}
