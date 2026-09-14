# Operational Provider — contract & boundary (M4)

Status: framework implemented; real 1C transport is **TBD** and must not be invented.

## Port

`src/lib/integrations/provider.ts` defines `OperationalProvider`:

```ts
interface OperationalProvider {
  readonly provider: 'ONE_C' | 'MOYSKLAD' | 'CUSTOM'
  healthcheck(): Promise<{ ok: boolean; message?: string }>
  pullProducts(cursor?: string): Promise<{ items: unknown[]; nextCursor?: string }>
  // M5: pullPrices / pullAvailability
  // M7: submitOrder / getOrderStatus
}
```

Rules:
- `items` are **raw** provider payloads. Only the catalog normalizer
  (`src/lib/catalog/normalize.ts`) maps them; provider-specific shapes never
  enter canonical data.
- Canonical identity is mapped to the provider via `ExternalReference`
  (`connectionId`, `entityType`, `externalId` → canonical `id`). Canonical ids
  are stable across re-imports and provider swaps.
- Credentials come from secret storage / environment, never from the
  `IntegrationConnection.config` blob and never in logs.

## Adapters

- `CUSTOM` → deterministic mock provider (`mock-provider.ts`), driven by
  `connection.config.fixtures` (array of raw product payloads) and
  `config.pageSize`. Used for dev/tests and to exercise the full pipeline before
  a real ERP exists.
- `ONE_C`, `MOYSKLAD` → **not configured yet** (`ProviderNotConfiguredError`).
  Their transport/authentication/paging contract is undefined and is not
  fabricated here.

## 1C contract — to be defined (TBD)

When the real 1C transport is agreed, implement an adapter behind the same port.
Open questions that must be answered by the integration (do not guess):
- transport (HTTP endpoint, OData, file exchange, message queue?)
- authentication & credential storage
- catalog paging model (cursor / page number / changed-since timestamp)
- payload schema for products, and later prices/availability/orders
- delete/archive semantics (soft vs hard)

The adapter maps that payload into the raw shape `pullProducts` returns; the
existing normalizer + durable runner require no change.

## Durability

Authoritative state is PostgreSQL (no broker):
`IntegrationJob` / `IntegrationAttempt` / `IntegrationError` (runner + DLQ),
`SyncCheckpoint` (page-based resume), `Inbox` (inbound idempotency),
`ProviderSnapshot` (evidence). Jobs are idempotent, bounded-retry and resume
after restart.
