/** Browser/PDF formatter for canonical nonnegative decimal strings; no binary-float conversion. */
export function formatMoney(value: string): string {
  const [whole, cents = '00'] = value.split('.')
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + ',' + cents.padEnd(2, '0')
}
