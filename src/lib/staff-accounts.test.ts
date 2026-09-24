import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@/lib/authz'

const mocks = vi.hoisted(() => ({
  hash: vi.fn(),
  outsideFind: vi.fn(),
  transaction: vi.fn(),
  insideFind: vi.fn(),
  lock: vi.fn(),
  create: vi.fn(),
  audit: vi.fn(),
}))
vi.mock('bcryptjs', () => ({ default: { hash: mocks.hash } }))
vi.mock('@/lib/audit', () => ({ recordAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ prisma: { user: { findFirst: mocks.outsideFind }, $transaction: mocks.transaction } }))

import { createStaffAccount } from './staff-accounts'

const actor = { id: 'admin-1', email: 'owner@example.test', storeId: 'store-1', role: 'ADMIN', status: 'ACTIVE' } as SessionUser
const tx = { $queryRaw: mocks.lock, user: { findFirst: mocks.insideFind, create: mocks.create } }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.outsideFind.mockResolvedValue({ id: actor.id })
  mocks.hash.mockResolvedValue('safe-hash')
  mocks.transaction.mockImplementation((callback: (client: typeof tx) => unknown) => callback(tx))
  mocks.insideFind.mockResolvedValueOnce({ id: actor.id }).mockResolvedValueOnce(null)
  mocks.create.mockResolvedValue({ id: 'staff-1', email: 'staff@example.test', name: 'Иван', role: 'STAFF', status: 'ACTIVE', createdAt: new Date('2026-01-01') })
})

describe('createStaffAccount', () => {
  it('creates an active scoped account and audits no password material', async () => {
    const result = await createStaffAccount(actor, { name: ' Иван ', email: ' STAFF@Example.test ', password: 'strong-password-123', role: 'STAFF' })

    expect(result.id).toBe('staff-1')
    expect(mocks.hash).toHaveBeenCalledWith('strong-password-123', 12)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ storeId: 'store-1', email: 'staff@example.test', name: 'Иван', passwordHash: 'safe-hash', role: 'STAFF', status: 'ACTIVE', moderatedById: 'admin-1' }) }))
    expect(mocks.audit).toHaveBeenCalledWith(tx, expect.objectContaining({ actor, action: 'StaffAccountCreated', targetId: 'staff-1', metadata: { email: 'staff@example.test', role: 'STAFF' } }))
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('strong-password')
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('safe-hash')
  })

  it('rejects a non-admin before hashing the password', async () => {
    mocks.outsideFind.mockResolvedValue(null)

    await expect(createStaffAccount(actor, { name: 'Staff', email: 'staff@example.test', password: 'strong-password-123', role: 'STAFF' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(mocks.hash).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('rejects an existing store email without changing that account', async () => {
    mocks.insideFind.mockReset().mockResolvedValueOnce({ id: actor.id }).mockResolvedValueOnce({ id: 'existing' })

    await expect(createStaffAccount(actor, { name: 'Admin', email: 'existing@example.test', password: 'strong-password-123', role: 'ADMIN' })).rejects.toMatchObject({ code: 'EMAIL_EXISTS' })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it.each(['short', 'я'.repeat(40)])('rejects an unsafe password before database access', async password => {
    await expect(createStaffAccount(actor, { name: 'Staff', email: 'staff@example.test', password, role: 'STAFF' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(mocks.outsideFind).not.toHaveBeenCalled()
    expect(mocks.hash).not.toHaveBeenCalled()
  })
})
