import type { IntegrationConnection } from '@prisma/client'
import { createMockProvider } from '@/lib/integrations/mock-provider'
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
export function getProvider(connection: Pick<IntegrationConnection, 'provider' | 'config'>): OperationalProvider {
  const config = (connection.config ?? {}) as Record<string, unknown>
  const fixtures = Array.isArray(config.fixtures) ? (config.fixtures as Array<Record<string, unknown>>) : null

  if (connection.provider === 'CUSTOM' || fixtures) {
    return createMockProvider({
      products: fixtures ?? [],
      pageSize: typeof config.pageSize === 'number' ? config.pageSize : undefined,
      provider: connection.provider,
    })
  }

  // ONE_C / MOYSKLAD real transports are not defined yet.
  throw new ProviderNotConfiguredError(connection.provider)
}
