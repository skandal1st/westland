import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ capability: vi.fn(), project: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/capabilities', () => ({ assertCapability: mocks.capability }))
vi.mock('./availability', () => ({ projectChannelAvailability: mocks.project }))
vi.mock('@/lib/audit', () => ({
  AuditAction: { FulfillmentChannelChanged: 'FulfillmentChannelChanged' },
  recordAudit: mocks.audit,
}))
vi.mock('@/lib/db', () => ({ prisma: {} }))

import { FulfillmentChannelUpdateError, updateFulfillmentChannel } from './setup'

const actor = {
  id: 'admin-1', email: 'admin@example.com', storeId: 'store-1', role: 'ADMIN' as const,
  status: 'ACTIVE' as const, customerId: null, priceGroupId: null,
}
const input = {
  storeId: 'store-1', channelId: 'channel-1', code: 'retail', name: 'Розница',
  paymentMethod: 'BANK_TRANSFER' as const, inventoryLocationId: 'location-2', priceBookId: 'book-1', isActive: false, actor,
}
const current = {
  id: 'channel-1', code: 'old', name: 'Старый', paymentMethod: 'CASH',
  inventoryLocationId: 'location-1', priceBookId: null, isActive: true,
}

function client(options: { channel?: unknown; location?: unknown; priceBook?: unknown; update?: unknown } = {}) {
  const tx = {
    fulfillmentChannel: {
      findFirst: vi.fn().mockResolvedValue(options.channel === undefined ? current : options.channel),
      update: vi.fn().mockResolvedValue(options.update ?? { ...current, ...input, id: 'channel-1', actor: undefined, storeId: undefined, channelId: undefined }),
    },
    inventoryLocation: { findFirst: vi.fn().mockResolvedValue(options.location === undefined ? { id: 'location-2' } : options.location) },
    priceBook: { findFirst: vi.fn().mockResolvedValue(options.priceBook === undefined ? { id: 'book-1' } : options.priceBook) },
  }
  return { tx, db: { $transaction: vi.fn((run: (value: typeof tx) => unknown) => run(tx)) } }
}

beforeEach(() => vi.clearAllMocks())

describe('updateFulfillmentChannel', () => {
  it('updates a store-scoped channel, rebuilds availability and audits before/after values', async () => {
    const { tx, db } = client()

    const channel = await updateFulfillmentChannel(input, db as never)

    expect(mocks.capability).toHaveBeenCalledWith('commerce-core')
    expect(tx.fulfillmentChannel.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'channel-1', storeId: 'store-1' } }))
    expect(tx.inventoryLocation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'location-2', storeId: 'store-1' } }))
    expect(tx.priceBook.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'book-1', storeId: 'store-1' } }))
    expect(tx.fulfillmentChannel.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ code: 'retail', inventoryLocationId: 'location-2', isActive: false }) }))
    expect(mocks.project).toHaveBeenCalledWith(channel.id, tx)
    expect(mocks.audit).toHaveBeenCalledWith(tx, expect.objectContaining({
      storeId: 'store-1', actor, action: 'FulfillmentChannelChanged', metadata: { before: current, after: channel },
    }))
  })

  it('does not update a channel outside the store', async () => {
    const { tx, db } = client({ channel: null })

    await expect(updateFulfillmentChannel(input, db as never)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(tx.fulfillmentChannel.update).not.toHaveBeenCalled()
    expect(mocks.project).not.toHaveBeenCalled()
  })

  it.each([
    [{ location: null }, 'missing location'],
    [{ priceBook: null }, 'missing price book'],
  ])('rejects a cross-store or missing reference: $1', async (options, _label) => {
    const { tx, db } = client(options)
    const update = updateFulfillmentChannel(input, db as never)

    await expect(update).rejects.toBeInstanceOf(FulfillmentChannelUpdateError)
    await expect(update).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })
    expect(tx.fulfillmentChannel.update).not.toHaveBeenCalled()
  })
})
