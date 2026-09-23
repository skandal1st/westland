import { Prisma } from '@prisma/client'

// Isolated configuration: never change Prisma's/global Decimal rounding.
const Decimal = Prisma.Decimal.clone({ precision: 48, rounding: Prisma.Decimal.ROUND_HALF_UP })
export const MONEY_POLICY = 'R21_HALF_UP_LINE_2_GROSS_TOTAL_V1' as const
export type DecimalInput = string | number | Prisma.Decimal
export class MoneyError extends Error {
  constructor(public code: 'INVALID_AMOUNT' | 'MIXED_CURRENCY' = 'INVALID_AMOUNT') { super(code); this.name = 'MoneyError' }
}
export function decimal(value: DecimalInput): Prisma.Decimal {
  let result: Prisma.Decimal
  try { result = new Decimal(value.toString()) } catch { throw new MoneyError() }
  if (!result.isFinite() || result.isNegative()) throw new MoneyError()
  return result
}
export function money(value: DecimalInput): string {
  const result = decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
  if (result.greaterThan('9999999999999999.99')) throw new MoneyError()
  return result.toFixed(2)
}
export function lineAmount(unitPrice: DecimalInput, quantity: DecimalInput): string {
  const qty = decimal(quantity)
  if (qty.isZero() || qty.decimalPlaces() > 3 || qty.greaterThan('999999999999999.999')) throw new MoneyError()
  return money(decimal(money(unitPrice)).mul(qty))
}
export function sumMoney(values: DecimalInput[]): string {
  return money(values.reduce<Prisma.Decimal>((sum, value) => sum.add(money(value)), decimal(0)))
}
export function oneCurrency(currencies: string[]): string {
  const unique = new Set(currencies)
  if (unique.size !== 1 || !currencies[0]?.trim()) throw new MoneyError('MIXED_CURRENCY')
  return currencies[0]
}
export function grossTax(total: DecimalInput, input: { vatEnabled: boolean; vatRate?: number }) {
  const gross = money(total)
  const rate = input.vatEnabled && input.vatRate != null && input.vatRate > 0 ? input.vatRate : null
  if (input.vatRate != null && (!Number.isFinite(input.vatRate) || input.vatRate < 0 || input.vatRate > 100 || decimal(input.vatRate).decimalPlaces() > 3)) throw new MoneyError()
  const vatAmount = rate === null ? '0.00' : money(decimal(gross).mul(rate).div(decimal(100).add(rate)))
  return { total: gross, vatRate: rate, vatAmount, subtotal: money(decimal(gross).sub(vatAmount)) }
}
