import type { CommercialSnapshot } from '@/lib/orders/commercial-snapshot'
/**
 * OperationalProvider — the replaceable boundary to an external operational
 * system (1C, MoySklad, AXIMA One, ...). The domain depends on this port, never
 * on a concrete adapter, and provider payloads stay raw (`unknown`) until the
 * catalog normalizer maps them — so provider-specific shapes never leak into
 * canonical data.
 *
 * M4 implements catalog read (pullProducts) + healthcheck. Prices/availability
 * (pullPrices/pullAvailability) arrive in M5; order export (submitOrder/
 * getOrderStatus) in M7. The 1C transport/contract is TBD and is NOT invented
 * here (see docs/integrations/OPERATIONAL_PROVIDER.md).
 */
export type ProviderKind = 'ONE_C' | 'MOYSKLAD' | 'CUSTOM'

export type ImportMode = 'full' | 'delta' | 'unknown'
export type ProviderPage = { items: unknown[]; nextCursor?: string; mode?: ImportMode; scope?: string[]; sourceUpdatedAt?: string | null }

/** Transport-independent order payload. `id` is the Commerce Order ID = idempotency key. */
export type OrderExportPayload = {
  /** Immutable accepted terms, including seller, warehouse, VAT and exact decimal strings. */
  terms: CommercialSnapshot
  id: string
  number: string
  customer: { id: string; inn: string; legalName: string }
  delivery: { name: string; city: string; address: string }
  channel: { code: string; paymentMethod: string }
  items: Array<{ sku: string; quantity: string; unitPrice: string }>
  total: string
  currency: string
}

export interface OperationalProvider {
  generationId?: string
  sourceId?: string
  readonly provider: ProviderKind
  healthcheck(): Promise<{ ok: boolean; message?: string }>
  /** One page of raw product payloads. `cursor` is opaque and provider-defined. */
  pullProducts(cursor?: string): Promise<ProviderPage>
  /** One page of raw price payloads (M5). Optional until a provider supplies prices. */
  pullPrices?(cursor?: string): Promise<ProviderPage>
  /** One page of raw availability payloads (M5). */
  pullAvailability?(cursor?: string): Promise<ProviderPage>
  /** Submit an order (M7). MUST be idempotent on `order.id`. */
  submitOrder?(order: OrderExportPayload): Promise<{ externalId: string; acceptedAt: Date }>
  /** Reconcile a business decision. Adapters must normalize native statuses.
   * CONFIRMED approves the original composition/total; PARTIALLY_CONFIRMED
   * requires review. Transport ACCEPTED is not business confirmation.
   * customerMessage, if present, must be safe for the buyer, never a raw error.
   */
  getOrderStatus?(externalId: string): Promise<{ status: string; customerMessage?: string }>
}

export class ProviderNotConfiguredError extends Error {
  constructor(public provider: ProviderKind) {
    super(`Operational provider "${provider}" is not configured (transport/contract TBD).`)
    this.name = 'ProviderNotConfiguredError'
  }
}
