/** Fictional references for OFFLINE tests only. Never import these into a customer database. */
import { MONEY_POLICY } from '../../src/lib/money'
import type { CommercialSnapshot } from '../../src/lib/orders/commercial-snapshot'
import { digest, envelope } from '../../src/lib/integrations/enterprisedata/message'
import { renderOrder, type OrderInput } from '../../src/lib/integrations/enterprisedata/order'
export const now = '2026-09-22T12:00:00.000Z'
export const peer = { plan: 'СинхронизацияДанныхЧерезУниверсальныйФормат', from: 'OFFLINE-1C', to: 'OFFLINE-SITE', messageNo: 0, receivedNo: 0 }
export const settings = Buffer.from(envelope(peer, [], now, true))
export const snapshot: CommercialSnapshot = {
  version: 1, calculationPolicy: MONEY_POLICY, orderId: 'ed-test:synthetic-1', storeId: 'offline', number: 'ED-TEST-OFFLINE-1', acceptedAt: now, connectionId: null,
  seller: { companyName: 'Вымышленный продавец', inn: '7712345678', vatEnabled: true, vatRate: 22 },
  buyer: { id: 'buyer', legalName: 'ИП Вымышленный & Тестовый', inn: '771234567890', kpp: null },
  delivery: { id: 'point', name: 'Тестовая точка', city: 'Тестовый город', address: 'Тестовая <улица>, 8' },
  warehouse: { id: 'warehouse', code: 'offline', name: 'Тестовый склад' },
  channel: { id: 'channel', code: 'bank', name: 'Банк', paymentMethod: 'BANK_TRANSFER' },
  pricing: { groupId: null, bookId: 'book', bookCode: 'base', bookName: 'Base' },
  tax: { mode: 'GROSS_INCLUDED', rate: 22, subtotal: '221.31', amount: '48.69' }, currency: 'RUB', total: '270.00', comment: 'OFFLINE ONLY',
  lines: [{ id: 'line', productId: 'product', variantId: 'variant', sku: 'sku', sourceSku: null, name: 'Вымышленный товар', packaging: 'шт', quantity: '1', unitPrice: '270.00', lineTotal: '270.00', listUnitPrice: '270.00', promotionIds: [] }],
}
export function fixture() {
  const input: OrderInput = { testOnly: true, requestKey: 'synthetic-1', deliveryMethod: 'ДоКлиента', snapshot: structuredClone(snapshot), references: {
    evidenceSha256: '0'.repeat(64), organization: '11111111-1111-4111-8111-111111111111', counterparty: '22222222-2222-4222-8222-222222222222', warehouse: '33333333-3333-4333-8333-333333333333',
    products: [{ variantId: 'variant', ref: '44444444-4444-4444-8444-444444444444', unitCode: '796', unitName: 'Штука' }],
  } }
  const evidence = Buffer.from(envelope({ ...peer, messageNo: 1 }, [renderOrder(input, '55555555-5555-4555-8555-555555555555')], now))
  input.references.evidenceSha256 = digest(evidence)
  return { input, evidence }
}
