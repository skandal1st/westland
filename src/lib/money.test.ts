import { expect, it } from 'vitest'
import { decimal, money, lineAmount, sumMoney, grossTax, oneCurrency } from './money'
import { formatMoney } from './money-format'
import { resolvePromotedAmountExact, type PromotionRule } from './pricing/promotions'

it.each([['1.005', '1.01'], ['2.675', '2.68'], ['0.0049', '0.00'], ['0.005', '0.01'], ['9999999999999999.99', '9999999999999999.99']])('rounds %s HALF_UP to %s', (input, expected) => {
  expect(money(input)).toBe(expected)
})
it('sums rounded lines rather than rounding an unrounded order total', () => {
  expect(lineAmount('0.05', '0.1')).toBe('0.01')
  expect(sumMoney([lineAmount('0.05', '0.1'), lineAmount('0.05', '0.1')])).toBe('0.02')
})
it.each(['-0.01', 'NaN', 'Infinity', '10000000000000000', '9999999999999999.995'])('rejects invalid or overflowing money %s', value => {
  expect(() => money(value)).toThrow('INVALID_AMOUNT')
})
it.each(['0', '-1', '1.0001', '1000000000000000'])('rejects invalid quantity %s', value => {
  expect(() => lineAmount('1', value)).toThrow('INVALID_AMOUNT')
})
it('rejects currency mixing instead of selecting the last currency', () => {
  expect(oneCurrency(['RUB', 'RUB'])).toBe('RUB')
  expect(() => oneCurrency(['RUB', 'USD'])).toThrow('MIXED_CURRENCY')
})
it('extracts tax with exact half-up rounding and derives net by subtraction', () => {
  expect(grossTax('0.03', { vatEnabled: true, vatRate: 20 })).toEqual({ total: '0.03', subtotal: '0.02', vatAmount: '0.01', vatRate: 20 })
  expect(grossTax('122.00', { vatEnabled: true, vatRate: 22 })).toEqual({ total: '122.00', subtotal: '100.00', vatAmount: '22.00', vatRate: 22 })
  expect(grossTax('122.00', { vatEnabled: false })).toEqual({ total: '122.00', subtotal: '122.00', vatAmount: '0.00', vatRate: null })
})
it.each([NaN, Infinity, -1, 101, 0.0001])('rejects unsupported VAT precision/range %s', vatRate => {
  expect(() => grossTax('122', { vatEnabled: true, vatRate })).toThrow('INVALID_AMOUNT')
})
it('matches an independent integer-cent oracle across fractions and very large values', () => {
  const fixed = (n: bigint) => (n / BigInt('100')).toString() + '.' + (n % BigInt('100')).toString().padStart(2, '0')
  for (const cents of [BigInt('1'), BigInt('5'), BigInt('267'), BigInt('10005'), BigInt('9007199254740993'), BigInt('999999999999999999')]) {
    for (const milli of [BigInt('1'), BigInt('125'), BigInt('333'), BigInt('999'), BigInt('1000')]) {
      const expected = (cents * milli + BigInt('500')) / BigInt('1000')
      expect(lineAmount(fixed(cents), (Number(milli) / 1000).toString())).toBe(fixed(expected))
    }
    const taxCents = (cents * BigInt('22') * BigInt('2') + BigInt('122')) / (BigInt('122') * BigInt('2'))
    const tax = grossTax(fixed(cents), { vatEnabled: true, vatRate: 22 })
    expect(tax.vatAmount).toBe(fixed(taxCents))
    expect(decimal(tax.subtotal).add(tax.vatAmount).toFixed(2)).toBe(fixed(cents))
  }
})
it('keeps promotion order and rounds each rule with exact decimal arithmetic', () => {
  const rule: PromotionRule = { id: 'a', type: 'PERCENTAGE', value: '5', priority: 10, stackable: false, isActive: true, startsAt: null, endsAt: null, scope: null }
  expect(resolvePromotedAmountExact({ amount: '1.50' }, { variantId: 'v' }, [rule, { ...rule, id: 'b', priority: 5, stackable: true }], new Date())).toEqual({ amount: '1.36', listAmount: '1.50', promotionIds: ['a', 'b'] })
  expect(resolvePromotedAmountExact({ amount: '90071992547409.93' }, { variantId: 'v' }, [{ ...rule, type: 'FIXED_AMOUNT', value: '0.01' }], new Date()).amount).toBe('90071992547409.92')
})
it('formats money for browser/PDF without conversion through Number', () => {
  expect(formatMoney('9999999999999999.99')).toBe('9\u00a0999\u00a0999\u00a0999\u00a0999\u00a0999,99')
  expect(formatMoney('0.01')).toBe('0,01')
})
