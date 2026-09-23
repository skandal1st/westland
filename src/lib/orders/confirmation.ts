import type { OrderManualConfirmation, OrderStatus } from '@prisma/client';
import { fingerprint } from '@/lib/catalog/normalize';
import type { CommercialSnapshot } from './commercial-snapshot';
type ConfirmationOrder = {
    id: string;
    storeId: string;
    status: OrderStatus;
    export: {
        externalId: string | null;
        confirmedAt: Date | null;
        connectionId: string | null;
        status: string;
    } | null;
    manualConfirmation?: OrderManualConfirmation | null;
};
/** One gate for invoice issuance and staff visibility. Manual proof never fabricates an ERP ID. */
export function hasInvoiceConfirmation(order: ConfirmationOrder, terms: CommercialSnapshot | null): boolean {
    if (!terms || terms.orderId !== order.id || terms.storeId !== order.storeId || terms.connectionId !== order.export?.connectionId || !['CONFIRMED', 'PROCESSING', 'COMPLETED'].includes(order.status))
        return false;
    if (order.export?.externalId && order.export.confirmedAt)
        return true;
    const proof = order.manualConfirmation;
    return !!proof && !proof.revokedAt && proof.orderId === order.id && proof.storeId === order.storeId && proof.connectionId === terms.connectionId
        && order.export?.status === 'DELIVERED' && proof.termsHash === fingerprint(terms)
        && proof.total.toFixed(2) === terms.total && proof.vatAmount.toFixed(2) === terms.tax.amount;
}
