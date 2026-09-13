export type DemoProduct = {
  id: string
  brand: string
  name: string
  category: string
  packaging: string
  stocks: { BANK_TRANSFER: number; CASH: number }
  price: number
  tone: string
}

export const categories = [
  { name: 'Новинки', count: 12 },
  { name: 'Табак', count: 86 },
  { name: 'Уголь', count: 24 },
  { name: 'Кальяны', count: 18 },
  { name: 'Чаши', count: 31 },
  { name: 'Аксессуары', count: 47 },
]

export const brands = ['Black Burn', 'Bonche', 'Banger', 'Spectrum', 'Must Have', 'Starline']

export const products: DemoProduct[] = [
  { id: 'p1', brand: 'BLACK BURN', name: 'Sample One', category: 'Табак', packaging: '25 г', stocks: { BANK_TRANSFER: 48, CASH: 11 }, price: 590, tone: '#22242a' },
  { id: 'p2', brand: 'BONCHE', name: 'Sample Two', category: 'Табак', packaging: '30 г', stocks: { BANK_TRANSFER: 16, CASH: 0 }, price: 640, tone: '#613aa9' },
  { id: 'p3', brand: 'BANGER', name: 'Sample Three', category: 'Табак', packaging: '25 г', stocks: { BANK_TRANSFER: 32, CASH: 8 }, price: 570, tone: '#e73c64' },
  { id: 'p4', brand: 'SPECTRUM', name: 'Sample Four', category: 'Табак', packaging: '40 г', stocks: { BANK_TRANSFER: 7, CASH: 21 }, price: 720, tone: '#04a7a1' },
  { id: 'p5', brand: 'MUST HAVE', name: 'Sample Five', category: 'Табак', packaging: '25 г', stocks: { BANK_TRANSFER: 28, CASH: 5 }, price: 610, tone: '#e86724' },
  { id: 'p6', brand: 'STARLINE', name: 'Sample Six', category: 'Табак', packaging: '30 г', stocks: { BANK_TRANSFER: 0, CASH: 14 }, price: 540, tone: '#356bc7' },
  { id: 'p7', brand: 'WESTSIDE', name: 'Sample Seven', category: 'Уголь', packaging: '1 кг', stocks: { BANK_TRANSFER: 54, CASH: 18 }, price: 430, tone: '#111111' },
  { id: 'p8', brand: 'WESTSIDE', name: 'Sample Eight', category: 'Аксессуары', packaging: '1 шт.', stocks: { BANK_TRANSFER: 19, CASH: 0 }, price: 890, tone: '#7344d2' },
]
