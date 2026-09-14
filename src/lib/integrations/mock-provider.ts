import type { OperationalProvider, ProviderKind, ProviderPage } from '@/lib/integrations/provider'

/**
 * Deterministic, paginated fixture provider for dev/tests. The cursor is a
 * numeric offset encoded as a string. `failOnPage` simulates a provider outage
 * mid-import so checkpoint/resume can be exercised.
 */
export function createMockProvider(options: {
  products: Array<Record<string, unknown>>
  prices?: Array<Record<string, unknown>>
  availability?: Array<Record<string, unknown>>
  pageSize?: number
  failOnPage?: number
  provider?: ProviderKind
  healthy?: boolean
}): OperationalProvider {
  const pageSize = Math.max(options.pageSize ?? 2, 1)
  const paginate = (items: Array<Record<string, unknown>>, cursor?: string): ProviderPage => {
    const start = cursor ? Number(cursor) : 0
    const nextStart = start + pageSize
    return { items: items.slice(start, start + pageSize), nextCursor: nextStart < items.length ? String(nextStart) : undefined }
  }
  return {
    provider: options.provider ?? 'CUSTOM',
    async healthcheck() {
      return options.healthy === false ? { ok: false, message: 'mock provider down' } : { ok: true }
    },
    async pullProducts(cursor?: string): Promise<ProviderPage> {
      const start = cursor ? Number(cursor) : 0
      const page = Math.floor(start / pageSize) + 1
      if (options.failOnPage && page === options.failOnPage) throw new Error(`mock provider failure on page ${page}`)
      return paginate(options.products, cursor)
    },
    async pullPrices(cursor?: string): Promise<ProviderPage> {
      return paginate(options.prices ?? [], cursor)
    },
    async pullAvailability(cursor?: string): Promise<ProviderPage> {
      return paginate(options.availability ?? [], cursor)
    },
  }
}
