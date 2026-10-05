import { describe, expect, it } from 'vitest'
import { parseProductBadges } from './badges'

describe('parseProductBadges', () => {
  it('keeps supported badges in the storefront order', () => {
    expect(parseProductBadges(['LIMITED', 'HIT', 'NEW'])).toEqual(['HIT', 'NEW', 'LIMITED'])
  })

  it('removes duplicate and unknown values from stored JSON', () => {
    expect(parseProductBadges(['HIT', 'UNKNOWN', 'HIT', 1])).toEqual(['HIT'])
    expect(parseProductBadges(null)).toEqual([])
  })
})
