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

export type ProviderPage = { items: unknown[]; nextCursor?: string }

export interface OperationalProvider {
  readonly provider: ProviderKind
  healthcheck(): Promise<{ ok: boolean; message?: string }>
  /** One page of raw product payloads. `cursor` is opaque and provider-defined. */
  pullProducts(cursor?: string): Promise<ProviderPage>
}

export class ProviderNotConfiguredError extends Error {
  constructor(public provider: ProviderKind) {
    super(`Operational provider "${provider}" is not configured (transport/contract TBD).`)
    this.name = 'ProviderNotConfiguredError'
  }
}
