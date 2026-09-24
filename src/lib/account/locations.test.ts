import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@/lib/authz'

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  audit: vi.fn(),
  transaction: vi.fn(),
  userFind: vi.fn(),
  lock: vi.fn(),
  updateMany: vi.fn(),
  count: vi.fn(),
  createLocation: vi.fn(),
  createGrant: vi.fn(),
}))

vi.mock('@/lib/capabilities', () => ({ assertCapability: mocks.capability }))
vi.mock('@/lib/audit', () => ({ recordAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ prisma: { $transaction: mocks.transaction } }))

import { createBuyerLocationForStaff } from './locations'

const actor = { id: 'staff-1', storeId: 'store-1', role: 'STAFF', status: 'ACTIVE' } as SessionUser
const tx = {
  user: { findFirst: mocks.userFind },
  $queryRaw: mocks.lock,
  customerLocation: { updateMany: mocks.updateMany, count: mocks.count, create: mocks.createLocation },
  userDeliveryPointGrant: { create: mocks.createGrant },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.transaction.mockImplementation((callback: (client: typeof tx) => unknown) => callback(tx))
  mocks.userFind.mockResolvedValueOnce({ id: actor.id }).mockResolvedValueOnce({ id: 'buyer-1', customerId: 'customer-1' })
  mocks.count.mockResolvedValue(0)
  mocks.createLocation.mockResolvedValue({ id: 'point-1', isDefault: true })
})

describe('createBuyerLocationForStaff', () => {
  it('creates the point inside the buyer company, grants access, and audits the actor', async () => {
    await expect(createBuyerLocationForStaff('buyer-1', actor, { name: 'Shop', city: 'City', address: 'Street' })).resolves.toMatchObject({ id: 'point-1' })

    expect(mocks.userFind).toHaveBeenNthCalledWith(1, { where: { id: 'staff-1', storeId: 'store-1', status: 'ACTIVE', role: { in: ['STAFF', 'ADMIN'] } } })
    expect(mocks.userFind).toHaveBeenNthCalledWith(2, { where: { id: 'buyer-1', storeId: 'store-1', role: 'BUYER' }, select: { id: true, customerId: true } })
    expect(mocks.createLocation).toHaveBeenCalledWith({ data: expect.objectContaining({ customerId: 'customer-1', name: 'Shop', city: 'City', address: 'Street', isDefault: true }) })
    expect(mocks.createGrant).toHaveBeenCalledWith({ data: { userId: 'buyer-1', locationId: 'point-1', assignedById: 'staff-1', origin: 'MODERATOR' } })
    expect(mocks.audit).toHaveBeenCalledWith(tx, expect.objectContaining({ storeId: 'store-1', actor, action: 'StaffBuyerDeliveryPointCreated', targetId: 'point-1' }))
  })

  it('rejects an inactive or unauthorized actor before reading the buyer', async () => {
    mocks.userFind.mockReset().mockResolvedValueOnce(null)

    await expect(createBuyerLocationForStaff('buyer-1', actor, { name: 'Shop', city: 'City', address: 'Street' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.userFind).toHaveBeenCalledTimes(1)
    expect(mocks.createLocation).not.toHaveBeenCalled()
  })

  it('does not create a point for a buyer outside the actor store', async () => {
    mocks.userFind.mockReset().mockResolvedValueOnce({ id: actor.id }).mockResolvedValueOnce(null)

    await expect(createBuyerLocationForStaff('foreign-buyer', actor, { name: 'Shop', city: 'City', address: 'Street' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(mocks.createLocation).not.toHaveBeenCalled()
  })
})
