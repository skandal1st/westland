import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'

vi.mock('@/lib/db', () => ({ prisma: { user: { findUnique: vi.fn() } } }))

const current = { id: 'u1', email: 'buyer@test.local', name: 'Buyer', role: 'BUYER' as const, status: 'ACTIVE' as const, storeId: 's1', customerId: 'c2', priceGroupId: 'p2' }
const stale = { ...current, role: 'STAFF' as const, customerId: 'c1', priceGroupId: 'p1' }
const sessionCallback = authOptions.callbacks!.session!
function readSession() {
  return sessionCallback({ session: { user: { ...stale }, expires: '2099-01-01' }, token: { sub: 'u1', ...stale } } as unknown as Parameters<typeof sessionCallback>[0])
}

beforeEach(() => vi.clearAllMocks())

describe('current session authority', () => {
  it('replaces stale role and customer/price context with current database values', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(current as never)
    expect((await readSession()).user).toEqual(current)
  })
  it.each([null, { ...current, status: 'SUSPENDED' }, { ...current, storeId: 'other' }])('rejects missing, suspended or moved users: %j', async (user) => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user as never)
    await expect(readSession()).rejects.toThrow()
  })
  it('fails closed when the authority database is unavailable', async () => {
    vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('database unavailable'))
    await expect(readSession()).rejects.toThrow('database unavailable')
  })
})
