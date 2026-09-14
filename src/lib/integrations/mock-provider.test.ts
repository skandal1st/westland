import { describe, expect, it } from 'vitest'
import { createMockProvider } from '@/lib/integrations/mock-provider'

const products = [{ externalId: 'A' }, { externalId: 'B' }, { externalId: 'C' }]

describe('createMockProvider', () => {
  it('paginates deterministically with an opaque cursor', async () => {
    const p = createMockProvider({ products, pageSize: 2 })
    const first = await p.pullProducts()
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBe('2')
    const second = await p.pullProducts(first.nextCursor)
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeUndefined()
  })

  it('fails on the configured page to simulate an outage', async () => {
    const p = createMockProvider({ products, pageSize: 1, failOnPage: 2 })
    await expect(p.pullProducts()).resolves.toBeTruthy() // page 1 ok
    await expect(p.pullProducts('1')).rejects.toThrow(/page 2/)
  })

  it('reports health', async () => {
    expect((await createMockProvider({ products }).healthcheck()).ok).toBe(true)
    expect((await createMockProvider({ products, healthy: false }).healthcheck()).ok).toBe(false)
  })
})
