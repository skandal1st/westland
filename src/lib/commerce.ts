export type PaymentMethod = 'BANK_TRANSFER' | 'CASH'

export const fulfillmentChannels = {
  BANK_TRANSFER: {
    label: 'Безналичная оплата',
    shortLabel: 'Безналичный расчёт',
    warehouseName: 'Склад безналичной оплаты',
    warehouseCode: 'BANK',
  },
  CASH: {
    label: 'Наличная оплата',
    shortLabel: 'Наличный расчёт',
    warehouseName: 'Склад наличной оплаты',
    warehouseCode: 'CASH',
  },
} satisfies Record<PaymentMethod, { label: string; shortLabel: string; warehouseName: string; warehouseCode: string }>

export const brandBanners: Record<string, { title: string; description: string; tone: string; ink: string }> = {
  default: { title: 'WESTSIDE', description: 'Общий баннер каталога', tone: '#25242a', ink: '#ffffff' },
  'Black Burn': { title: 'BLACK BURN', description: 'Баннер активного бренда', tone: '#17191d', ink: '#ffffff' },
  Bonche: { title: 'BONCHE', description: 'Баннер активного бренда', tone: '#6947a8', ink: '#ffffff' },
  Banger: { title: 'BANGER', description: 'Баннер активного бренда', tone: '#dd365d', ink: '#ffffff' },
  Spectrum: { title: 'SPECTRUM', description: 'Баннер активного бренда', tone: '#07958f', ink: '#ffffff' },
  'Must Have': { title: 'MUST HAVE', description: 'Баннер активного бренда', tone: '#d75a20', ink: '#ffffff' },
  Starline: { title: 'STARLINE', description: 'Баннер активного бренда', tone: '#285cad', ink: '#ffffff' },
}
