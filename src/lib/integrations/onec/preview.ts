import { z } from 'zod'
import { parseCatalog, parseOffers, type OnecRawProduct, type OnecOffer } from './commerceml'
import { parseExchangeMetadata, mergeMetadata, type ExchangeMetadata } from './metadata'
import { readGenerationFile, sha256, SESSION_LIMIT, FILE_LIMIT } from './storage'
import { IntegrationInputError } from '../errors'

const manifestSchema = z.array(z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  name: z.string().min(1), size: z.number().int().positive().max(FILE_LIMIT),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['catalog', 'offers', 'asset']),
}).strict()).min(1).max(128)

/** Reads only an explicitly selected manifest. Never resolves the active/latest source. */
export async function readSourcePreview(connectionId: string, generation: { files: unknown; digest: string }) {
  const parsed = manifestSchema.safeParse(generation.files)
  if (!parsed.success) throw new IntegrationInputError('generation_manifest_invalid')
  // PostgreSQL jsonb reorders object keys; reconstruct the publisher's byte order.
  const files = parsed.data.map(f => ({ sessionId: f.sessionId, id: f.id, name: f.name, size: f.size, sha256: f.sha256, kind: f.kind }))
  if (sha256(JSON.stringify(files)) !== generation.digest) throw new IntegrationInputError('generation_manifest_invalid')
  if (new Set(files.map(f => f.name)).size !== files.length) throw new IntegrationInputError('duplicate_manifest_filename')
  if (files.reduce((sum, f) => sum + f.size, 0) > SESSION_LIMIT) throw new IntegrationInputError('preflight_size_limit')
  const products: OnecRawProduct[] = [], offers: OnecOffer[] = []
  const catalogMeta: ExchangeMetadata[] = [], offersMeta: ExchangeMetadata[] = []
  for (const file of files) {
    const xml = await readGenerationFile(connectionId, file) // Assets are verified too.
    if (file.kind === 'catalog') {
      catalogMeta.push(parseExchangeMetadata(xml, 'catalog'))
      parseCatalog(xml, product => {
        if (products.length >= 100_000) throw new IntegrationInputError('preflight_row_limit')
        products.push(product)
      })
    } else if (file.kind === 'offers') {
      offersMeta.push(parseExchangeMetadata(xml, 'offers'))
      parseOffers(xml, offer => {
        if (offers.length >= 100_000) throw new IntegrationInputError('preflight_row_limit')
        offers.push(offer)
      })
    }
  }
  return { products, offers, catalog: mergeMetadata(catalogMeta), values: mergeMetadata(offersMeta),
    files: files.map(({ name, size, sha256, kind }) => ({ name, size, sha256, kind })) }
}
