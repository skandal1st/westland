import { confirmOrderManually, manualConfirmationPreview } from '@/lib/orders/manual-confirmation';
import { transitionOrder } from '@/lib/orders/orders';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { checkout } from '@/lib/cart/checkout';
import { setCartChannel, setCartItem } from '@/lib/cart/cart';
import { submitOrder, cancelOrder } from '@/lib/orders/orders';
import { issueInvoice } from '@/lib/invoices/invoices';
import { querySales, acknowledgeSales } from '@/lib/integrations/onec/sale';
import { openExchangeSession } from '@/lib/integrations/onec/ledger';
import type { SessionUser } from '@/lib/authz';
const activeStore = vi.hoisted(() => ({ id: '' }));
vi.mock('@/lib/store', () => ({ getActiveStore: async () => activeStore }));
const db = new PrismaClient();
let storeId: string, channelId: string, variantId: string, productId: string, deliveryId: string, warehouseId: string, bookId: string, connectionId: string;
let user: SessionUser;
const seller = { companyName: 'ТЕСТ — НЕ ДЛЯ ОПЛАТЫ', inn: '7712345678', vatEnabled: true, vatRate: 22, bank: { name: 'Test bank', bik: '044525225', account: '40702810900000000001', corAccount: '30101810400000000225' } };
const profile = { enabled: true, format: 'COMMERCEML_2_10', currency: 'RUB', timeZone: 'Europe/Moscow' };
async function draft() { await setCartChannel(user, channelId); await setCartItem(user, variantId, 2); return checkout(user, { deliveryLocationId: deliveryId, idempotencyKey: randomUUID(), comment: 'Accepted note' }, db); }
beforeEach(async () => {
    storeId = (await db.store.create({ data: { slug: 'manual-confirm-' + randomUUID(), name: 'R20 isolated test' } })).id;
    await db.appSettings.create({ data: { storeId, invoicePrefix: 'R20-' + storeId.slice(-6), sellerRequisites: seller } });
    bookId = (await db.priceBook.create({ data: { storeId, code: 'original-book', name: 'Original price book', isDefault: true } })).id;
    warehouseId = (await db.inventoryLocation.create({ data: { storeId, code: 'original-warehouse', name: 'Original warehouse' } })).id;
    channelId = (await db.fulfillmentChannel.create({ data: { storeId, code: 'original-channel', name: 'Original channel', inventoryLocationId: warehouseId, paymentMethod: 'BANK_TRANSFER', priceBookId: bookId } })).id;
    productId = (await db.product.create({ data: { storeId, canonicalName: 'Original product', status: 'ACTIVE' } })).id;
    variantId = (await db.productVariant.create({ data: { storeId, productId, sku: 'ORIGINAL', sourceSku: 'ARTICLE', packaging: 'box', status: 'ACTIVE' } })).id;
    await db.priceEntry.create({ data: { priceBookId: bookId, variantId, amount: 122 } });
    const customer = await db.customer.create({ data: { storeId, displayName: 'Original buyer', legalName: 'Original buyer LLC', inn: '7798765432', kpp: '771201001' } });
    deliveryId = (await db.customerLocation.create({ data: { customerId: customer.id, name: 'Original delivery', address: 'Original street', city: 'Original city' } })).id;
    const buyer = await db.user.create({ data: { storeId, customerId: customer.id, email: 'buyer@r20.test', name: 'Buyer', passwordHash: 'test', role: 'BUYER', status: 'ACTIVE' } });
    user = { id: buyer.id, storeId, customerId: customer.id, priceGroupId: null, role: 'BUYER', status: 'ACTIVE', name: buyer.name, email: buyer.email };
    connectionId = (await db.integrationConnection.create({ data: { storeId, provider: 'ONE_C', name: 'R20 source', enabled: true, sourceState: 'ACTIVE', environment: 'TEST', config: { saleExport: profile } } })).id;
    activeStore.id = storeId;
    const entries = [
        ['product', productId, 'product-external', { baseUnit: { code: '796', name: 'Штука' } }],
        ['customer', user.customerId, 'customer-external', {}],
        ['location', warehouseId, 'warehouse-external', { warehouseAddress: { city: 'Test city', address: 'Warehouse street 1' } }],
        ['priceType', bookId, 'price-external', {}],
        ['seller', channelId, 'seller-external', seller],
        ['channel', channelId, channelId, { channelId, warehouseExternalId: 'warehouse-external', priceTypeExternalId: 'price-external', sellerExternalId: 'seller-external' }],
    ] as const;
    for (const [entityType, entityId, externalId, sourceData] of entries)
        await db.externalReference.create({ data: { connectionId, entityType, entityId: entityId!, externalId, sourceData } });
});
afterEach(async () => {
    vi.unstubAllEnvs();
    await db.order.deleteMany({ where: { storeId } });
    await db.integrationError.deleteMany({ where: { storeId } });
    await db.store.delete({ where: { id: storeId } });
});
async function authority() {
    const credentials = [{ connectionId, user: 'r22-local', pass: 'r22-local-test-only' }];
    const session = await openExchangeSession(storeId, credentials[0], 'r22-local-session-secret', db);
    return { storeId, sessionId: session.id, credentials, secret: 'r22-local-session-secret' };
}
async function submitted() { const order = await draft(); await submitOrder(user, order.id, db); return order; }
async function record(orderId: string) { return db.orderExport.findUniqueOrThrow({ where: { orderId } }); }
let manager: SessionUser;
beforeEach(async () => { const m = await db.user.create({ data: { storeId, email: 'manager@test.local', name: 'Manager', passwordHash: 'test', role: 'STAFF', status: 'ACTIVE' } }); manager = { id: m.id, email: m.email, name: m.name, storeId, role: 'STAFF', status: 'ACTIVE', customerId: null, priceGroupId: null }; });
afterAll(() => db.$disconnect());
async function delivered() { const order = await submitted(); const auth = await authority(); await querySales(auth, db); await acknowledgeSales(auth, db); return order; }
async function request(orderId: string) { const p = await manualConfirmationPreview({ storeId, orderId, actor: manager }, db); return { documentNumber: 'УТУТ-100001', documentDate: '2026-09-22', total: p.terms.total, vatAmount: p.terms.tax.amount!, termsHash: p.termsHash, termsMatch: true, vatChecked: true }; }
const confirm = (orderId: string, confirmation: unknown, actor = manager) => confirmOrderManually({ storeId, orderId, actor, confirmation }, db);
it('allows invoice after audited manual verification without fabricating an ERP ID or receipt', async () => {
    const o = await delivered();
    await expect(issueInvoice({ storeId, orderId: o.id, actor: manager }, db)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const proof = await confirm(o.id, await request(o.id));
    expect(proof.status).toBe('CONFIRMED');
    expect(await record(o.id)).toMatchObject({ status: 'DELIVERED', externalId: null, confirmedAt: null });
    const inv = await issueInvoice({ storeId, orderId: o.id, actor: manager }, db);
    expect(inv.total.toFixed(2)).toBe('244.00');
    expect(inv.vatAmount.toFixed(2)).toBe('44.00');
    expect(await db.auditEntry.count({ where: { targetId: o.id, action: 'OrderManuallyConfirmed' } })).toBe(1);
});
it('parallel retry persists one confirmation and one audit record', async () => { const o = await delivered(), r = await request(o.id); const res = await Promise.all([confirm(o.id, r), confirm(o.id, r)]); expect(res[0].id).toBe(res[1].id); expect(res.filter(x => x.repeated)).toHaveLength(1); expect(await db.orderManualConfirmation.count({ where: { orderId: o.id } })).toBe(1); expect(await db.auditEntry.count({ where: { targetId: o.id, action: 'OrderManuallyConfirmed' } })).toBe(1); });
it('does not overwrite an existing attestation with another document', async () => { const o = await delivered(), r = await request(o.id); await confirm(o.id, r); await expect(confirm(o.id, { ...r, documentNumber: 'Other' })).rejects.toMatchObject({ code: 'ALREADY_CONFIRMED' }); });
it('prevents one ERP document from confirming two website orders', async () => { const first = await delivered(); await confirm(first.id, await request(first.id)); const second = await delivered(); await expect(confirm(second.id, await request(second.id))).rejects.toMatchObject({ code: 'DOCUMENT_ALREADY_LINKED' }); expect((await db.order.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('SUBMITTED'); });
it.each([{ total: '245.00' }, { vatAmount: '0.00' }, { termsHash: '0'.repeat(64) }])('rejects mismatched amounts and stale terms: %j', async (change) => { const o = await delivered(), r = await request(o.id); await expect(confirm(o.id, { ...r, ...change })).rejects.toMatchObject({ code: 'termsHash' in change ? 'TERMS_CHANGED' : 'AMOUNTS_MISMATCH' }); expect(await db.orderManualConfirmation.count({ where: { orderId: o.id } })).toBe(0); });
it.each([{ termsMatch: false }, { vatChecked: false }, { documentDate: '2026-02-30' }, { documentNumber: '  ' }])('requires explicit verification and valid document details: %j', async (change) => { const o = await delivered(); await expect(confirm(o.id, { ...await request(o.id), ...change })).rejects.toMatchObject({ code: 'INVALID_INPUT' }); });
it('rejects unacknowledged transport, cancelled orders and cancellation requests', async () => { const o = await submitted(); await querySales(await authority(), db); await expect(manualConfirmationPreview({ storeId, orderId: o.id, actor: manager }, db)).rejects.toMatchObject({ code: 'INVALID_STATE' }); const a = await authority(); await querySales(a, db); await acknowledgeSales(a, db); const r = await request(o.id); await cancelOrder(user, o.id, db); await expect(confirm(o.id, r)).rejects.toMatchObject({ code: 'CANCELLATION_REQUESTED' }); await transitionOrder({ storeId, orderId: o.id, to: 'CANCELLED', actor: manager }, db); await expect(confirm(o.id, r)).rejects.toMatchObject({ code: 'INVALID_STATE' }); });
it('checks current active staff authority and tenant before writing', async () => { const o = await delivered(), r = await request(o.id); await expect(confirm(o.id, r, user)).rejects.toMatchObject({ code: 'FORBIDDEN' }); await expect(confirm(o.id, r, { ...manager, storeId: 'foreign' })).rejects.toMatchObject({ code: 'FORBIDDEN' }); await db.user.update({ where: { id: manager.id }, data: { status: 'SUSPENDED' } }); await expect(confirm(o.id, r)).rejects.toMatchObject({ code: 'FORBIDDEN' }); });
it('revokes manual invoice permission after cancellation and never reactivates it by replay', async () => { const o = await delivered(), r = await request(o.id); await confirm(o.id, r); await transitionOrder({ storeId, orderId: o.id, to: 'CANCELLED', actor: manager }, db); expect((await db.orderManualConfirmation.findUniqueOrThrow({ where: { orderId: o.id } })).revokedAt).not.toBeNull(); await expect(confirm(o.id, r)).rejects.toMatchObject({ code: 'INVALID_STATE' }); await expect(issueInvoice({ storeId, orderId: o.id, actor: manager }, db)).rejects.toMatchObject({ code: 'INVALID_STATE' }); });
it('confirmation racing cancellation cannot enable a cancelled order invoice', async () => { const o = await delivered(), r = await request(o.id); const results = await Promise.allSettled([confirm(o.id, r), transitionOrder({ storeId, orderId: o.id, to: 'CANCELLED', actor: manager }, db)]); if (results[1].status === 'rejected') {
    expect(results[1].reason).toMatchObject({ code: 'STATE_CHANGED' });
    await transitionOrder({ storeId, orderId: o.id, to: 'CANCELLED', actor: manager }, db);
} expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('CANCELLED'); await expect(issueInvoice({ storeId, orderId: o.id, actor: manager }, db)).rejects.toMatchObject({ code: 'INVALID_STATE' }); });
it('attestation identity and checked amounts cannot be edited in the database', async () => { const o = await delivered(); await confirm(o.id, await request(o.id)); await expect(db.orderManualConfirmation.update({ where: { orderId: o.id }, data: { documentNumber: 'changed' } })).rejects.toThrow('manual_confirmation_immutable'); });
