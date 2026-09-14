import { describe, expect, it } from 'vitest'
import { getProvider } from '@/lib/integrations/registry'
import { ProviderNotConfiguredError } from '@/lib/integrations/provider'

describe('getProvider', () => {
  it('builds a mock provider for a CUSTOM connection with fixtures', async () => {
    const provider = getProvider({ provider: 'CUSTOM', config: { fixtures: [{ externalId: 'X' }], pageSize: 1 } } as any)
    expect(provider.provider).toBe('CUSTOM')
    const page = await provider.pullProducts()
    expect(page.items).toHaveLength(1)
  })

  it('returns an empty mock for a CUSTOM connection without fixtures', async () => {
    const provider = getProvider({ provider: 'CUSTOM', config: null } as any)
    expect((await provider.pullProducts()).items).toHaveLength(0)
  })

  it('throws for a real provider with no configured transport', () => {
    expect(() => getProvider({ provider: 'ONE_C', config: null } as any)).toThrow(ProviderNotConfiguredError)
  })
})
