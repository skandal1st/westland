import type { IntegrationConnection } from '@prisma/client'
import { createMockProvider } from '@/lib/integrations/mock-provider'
import { createOneCProvider } from '@/lib/integrations/onec/provider'
import { ProviderNotConfiguredError, type OperationalProvider } from '@/lib/integrations/provider'

/**
 * Resolve the OperationalProvider for a connection.
 *
 * Real adapters (1C, MoySklad) are TBD — their transport/contract is not
 * invented here. A CUSTOM connection may carry `config.fixtures` (an array of
 * raw product payloads) which drives the deterministic mock provider, so the
 * whole import pipeline is exercisable end-to-end before a real ERP exists.
 * Provider credentials must come from secret storage, never the config blob.
 */
export function getProvider(connection: Pick<IntegrationConnection, 'id' | 'provider' | 'config'>, generationId?: string): OperationalProvider {
  const config = (connection.config ?? {}) as Record<string, unknown>
  const fixtures = Array.isArray(config.fixtures) ? (config.fixtures as Array<Record<string, unknown>>) : null

  const priceFixtures = Array.isArray(config.priceFixtures) ? (config.priceFixtures as Array<Record<string, unknown>>) : undefined
  const availabilityFixtures = Array.isArray(config.availabilityFixtures) ? (config.availabilityFixtures as Array<Record<string, unknown>>) : undefined

  if (connection.provider === 'CUSTOM') {
    return createMockProvider({
      products: fixtures ?? [],
      prices: priceFixtures,
      availability: availabilityFixtures,
      pageSize: typeof config.pageSize === 'number' ? config.pageSize : undefined,
      provider: connection.provider,
    })
  }

  // 1C "Обмен с сайтом": read the staged CommerceML files pushed to the volume.
  // config.brandGroups holds the group ids staff marked as brands.
  if (connection.provider === 'ONE_C') {
    const brandGroups = Array.isArray(config.brandGroups) ? config.brandGroups.filter((x): x is string => typeof x === 'string') : []
    return createOneCProvider(connection.id, generationId, brandGroups)
  }

  // MOYSKLAD real transport is not defined yet.
  throw new ProviderNotConfiguredError(connection.provider)
}

/** Pull adapters are driven by their authenticated inbound endpoint, never the push worker. */
export const PULL_ORDER_PROVIDERS = ['ONE_C'] as const
