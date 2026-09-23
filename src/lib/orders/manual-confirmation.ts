import { assertCapability } from '@/lib/capabilities'
import { z } from 'zod';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma as db } from '@/lib/db';
import type { SessionUser } from '@/lib/authz';
import { recordAudit } from '@/lib/audit';
import { fingerprint } from '@/lib/catalog/normalize';
import { readCommercialSnapshot } from './commercial-snapshot';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const d = new Date(value + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value; }, 'invalid_date');
export const ManualConfirmationSchema = z.object({
    documentNumber: z.string().trim().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/).transform(v => v.toUpperCase()),
    documentDate: date, termsHash: z.string().regex(/^[a-f0-9]{64}$/),
    total: z.string().regex(/^\d{1,16}\.\d{2}$/), vatAmount: z.string().regex(/^\d{1,16}\.\d{2}$/),
    termsMatch: z.literal(true), vatChecked: z.literal(true),
}).strict();
export class ManualConfirmationError extends Error {
    constructor(public code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID_STATE' | 'INVALID_INPUT' | 'TERMS_CHANGED' | 'AMOUNTS_MISMATCH' | 'CANCELLATION_REQUESTED' | 'ALREADY_CONFIRMED' | 'DOCUMENT_ALREADY_LINKED') { super(code); }
}
async function staff(client: PrismaClient | Prisma.TransactionClient, actor: SessionUser, storeId: string) {
    const current = await client.user.findFirst({ where: { id: actor.id, storeId, status: 'ACTIVE', role: { in: ['STAFF', 'ADMIN'] } }, select: { id: true, email: true } });
    if (actor.storeId !== storeId || !current)
        throw new ManualConfirmationError('FORBIDDEN');
    return current;
}
async function context(client: PrismaClient | Prisma.TransactionClient, storeId: string, orderId: string) {
    const order = await client.order.findFirst({ where: { id: orderId, storeId }, include: { export: { include: { onecDelivery: true } }, manualConfirmation: true } });
    if (!order)
        throw new ManualConfirmationError('NOT_FOUND');
    const terms = readCommercialSnapshot(order.commercialSnapshot, order);
    if (!terms?.seller || terms.tax.amount === null || !terms.connectionId || terms.connectionId !== order.export?.connectionId)
        throw new ManualConfirmationError('INVALID_STATE');
    const source = await client.integrationConnection.findFirst({ where: { id: terms.connectionId, storeId, provider: 'ONE_C' } });
    if (!source || order.export?.status !== 'DELIVERED' || !order.export.onecDelivery?.receivedAt || !['SUBMITTED', 'CONFIRMED', 'PROCESSING', 'COMPLETED'].includes(order.status))
        throw new ManualConfirmationError('INVALID_STATE');
    return { order, terms, source };
}
export async function manualConfirmationPreview(input: {
    storeId: string;
    orderId: string;
    actor: SessionUser;
}, client: PrismaClient = db) {
    await staff(client, input.actor, input.storeId);
    const { order, terms } = await context(client, input.storeId, input.orderId);
    if (order.cancellationRequestedAt)
        throw new ManualConfirmationError('CANCELLATION_REQUESTED');
    if (order.manualConfirmation || !['SUBMITTED', 'CONFIRMED'].includes(order.status) || order.export?.confirmedAt)
        throw new ManualConfirmationError('ALREADY_CONFIRMED');
    return { number: order.number, terms, termsHash: fingerprint(terms) };
}
export async function confirmOrderManually(input: {
    storeId: string;
    orderId: string;
    actor: SessionUser;
    confirmation: unknown;
}, client: PrismaClient = db) {
  assertCapability('commerce-core')

    const parsed = ManualConfirmationSchema.safeParse(input.confirmation);
    if (!parsed.success)
        throw new ManualConfirmationError('INVALID_INPUT');
    const request = parsed.data;
    try {
        return await client.$transaction(async (tx) => {
            const actor = await staff(tx, input.actor, input.storeId);
            await tx.$queryRaw `SELECT id FROM "Order" WHERE id = ${input.orderId} AND "storeId" = ${input.storeId} FOR UPDATE`;
            const { order, terms } = await context(tx, input.storeId, input.orderId);
            if (order.cancellationRequestedAt)
                throw new ManualConfirmationError('CANCELLATION_REQUESTED');
            if (fingerprint(terms) !== request.termsHash)
                throw new ManualConfirmationError('TERMS_CHANGED');
            if (request.total !== terms.total || request.vatAmount !== terms.tax.amount)
                throw new ManualConfirmationError('AMOUNTS_MISMATCH');
            const previous = order.manualConfirmation;
            if (previous) {
                if (previous.revokedAt || previous.documentNumber !== request.documentNumber || previous.documentDate.toISOString().slice(0, 10) !== request.documentDate || previous.termsHash !== request.termsHash)
                    throw new ManualConfirmationError('ALREADY_CONFIRMED');
                return { id: previous.id, status: order.status, repeated: true };
            }
            if (!['SUBMITTED', 'CONFIRMED'].includes(order.status) || order.export?.confirmedAt)
                throw new ManualConfirmationError('INVALID_STATE');
            const proof = await tx.orderManualConfirmation.create({ data: { orderId: order.id, storeId: order.storeId, connectionId: terms.connectionId!, documentNumber: request.documentNumber, documentDate: new Date(request.documentDate + 'T00:00:00Z'), termsHash: request.termsHash, total: request.total, vatAmount: request.vatAmount, actorId: actor.id, actorEmail: actor.email } });
            await tx.order.update({ where: { id: order.id }, data: { status: 'CONFIRMED', providerDecisionMessage: null } });
            await recordAudit(tx, { storeId: order.storeId, actor, action: 'OrderManuallyConfirmed', targetType: 'Order', targetId: order.id, metadata: { confirmationId: proof.id, from: order.status, to: 'CONFIRMED', documentNumber: request.documentNumber, documentDate: request.documentDate, termsHash: request.termsHash, total: request.total, vatAmount: request.vatAmount, termsMatch: true, vatChecked: true } });
            return { id: proof.id, status: 'CONFIRMED' as const, repeated: false };
        });
    }
    catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
            throw new ManualConfirmationError('DOCUMENT_ALREADY_LINKED');
        throw e;
    }
}
