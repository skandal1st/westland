import { describe, expect, it } from 'vitest'
import { catalogWhere } from './read'

describe('catalog stock visibility', () => {
  it('filters the default variant by positive channel availability when enabled', () => {
    const where = catalogWhere({ storeId: 'store-1', channelId: 'channel-1', hideOutOfStock: true })
    expect(where.AND).toEqual(expect.arrayContaining([{
      variants: { some: { isDefault: true, status: 'ACTIVE', availability: { some: { fulfillmentChannelId: 'channel-1', availableQuantity: { gt: 0 } } } } },
    }]))
  })

  it('keeps the full catalog when zero stock is shown or no channel is selected', () => {
    const visible = JSON.stringify(catalogWhere({ storeId: 'store-1', channelId: 'channel-1', hideOutOfStock: false }))
    const unknown = JSON.stringify(catalogWhere({ storeId: 'store-1', hideOutOfStock: true }))
    expect(visible).not.toContain('availableQuantity')
    expect(unknown).not.toContain('availableQuantity')
  })
})
