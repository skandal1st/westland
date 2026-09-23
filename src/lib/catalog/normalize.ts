import { createHash } from 'node:crypto'

/**
 * Normalization contract: Provider Snapshot -> Normalized (canonical) form.
 *
 * The normalizer version is stamped on every ProviderSnapshot so we can always
 * answer "which normalizer produced this canonical value". Bump it whenever the
 * mapping below changes in a way that affects output. The concrete provider
 * (1C/mock) arrives in M4; here we fix the transport-independent shape and a
 * defensive default normalizer.
 */
export const NORMALIZATION_VERSION = '1'

export type NormalizedIdentifier = { type: string; value: string }

export type NormalizedProduct = {
  externalId: string
  sku: string
  canonicalName: string
  categoryExternalId?: string
  categoryName?: string
  brandExternalId?: string
  brandName?: string
  packaging?: string
  unitsPerPack?: number
  identifiers: NormalizedIdentifier[]
  archived: boolean
  sourceUpdatedAt?: Date
}

export class NormalizationError extends Error {
  constructor(public field: string) {
    super(`Provider payload missing required field: ${field}`)
    this.name = 'NormalizationError'
  }
}

/** Deterministic hash of a payload, independent of key order. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/**
 * Map a raw provider payload to the normalized canonical form. Required fields
 * (externalId, sku, name) missing -> NormalizationError. Unknown fields are
 * ignored; identifiers/packaging are optional.
 */
export function normalizeProductSnapshot(payload: unknown): NormalizedProduct {
  const raw = (payload ?? {}) as Record<string, any>
  const externalId = str(raw.externalId ?? raw.id)
  if (!externalId) throw new NormalizationError('externalId')
  const sku = str(raw.sku ?? raw.code)
  if (!sku) throw new NormalizationError('sku')
  const canonicalName = str(raw.name ?? raw.canonicalName)
  if (!canonicalName) throw new NormalizationError('name')

  const identifiers: NormalizedIdentifier[] = Array.isArray(raw.identifiers)
    ? raw.identifiers
        .map((i: any) => ({ type: str(i?.type), value: str(i?.value) }))
        .filter((i: NormalizedIdentifier) => i.type && i.value)
    : []
  if (raw.barcode) identifiers.push({ type: 'BARCODE', value: str(raw.barcode) })

  return {
    externalId,
    sku,
    canonicalName,
    categoryExternalId: str(raw.categoryExternalId) || undefined,
    categoryName: str(raw.categoryName) || undefined,
    brandExternalId: str(raw.brandExternalId) || undefined,
    brandName: str(raw.brandName) || undefined,
    packaging: str(raw.packaging) || undefined,
    unitsPerPack: Number.isFinite(raw.unitsPerPack) ? Number(raw.unitsPerPack) : undefined,
    identifiers,
    archived: raw.archived === true || raw.deleted === true,
    sourceUpdatedAt: raw.sourceUpdatedAt ? new Date(raw.sourceUpdatedAt) : undefined,
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value)
}
