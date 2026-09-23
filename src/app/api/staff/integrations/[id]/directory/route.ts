import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireApiUser } from '@/lib/authz';
import { applyDirectoryAction, DirectoryAction } from '@/lib/integrations/enterprisedata/directory';
import { IntegrationInputError } from '@/lib/integrations/errors';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {
    params: {
        id: string;
    };
};
const Query = z.object({ kind: z.enum(['product', 'counterparty', 'productGroup', 'counterpartyGroup', 'partner']).default('counterparty'), q: z.string().trim().max(100).default(''), page: z.coerce.number().int().min(1).max(10000).default(1), mode: z.enum(['records', 'choices']).default('records') });
export async function GET(request: Request, { params }: Context) {
    const auth = await requireApiUser(['STAFF', 'ADMIN']);
    if ('response' in auth)
        return auth.response;
    const source = await prisma.integrationConnection.findFirst({ where: { id: params.id, storeId: auth.user.storeId, provider: 'ONE_C' } });
    if (!source)
        return NextResponse.json({ error: 'source_not_found' }, { status: 404 });
    const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success)
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    const { kind, q, page, mode } = parsed.data, storeId = auth.user.storeId;
    if (mode === 'choices') {
        const choices = kind === 'product' ? (await prisma.product.findMany({ where: { storeId, OR: [{ canonicalName: { contains: q, mode: 'insensitive' } }, { id: q }] }, select: { id: true, canonicalName: true }, orderBy: { canonicalName: 'asc' }, take: 20 })).map(v => ({ id: v.id, name: v.canonicalName }))
            : (await prisma.customer.findMany({ where: { storeId, OR: [{ displayName: { contains: q, mode: 'insensitive' } }, { inn: { contains: q } }] }, select: { id: true, displayName: true, inn: true, locations: {select: {id: true, name: true, city: true, address: true}, orderBy: {name: 'asc'}} }, orderBy: { displayName: 'asc' }, take: 20 })).map(v => ({ id: v.id, name: v.displayName + ' · ' + v.inn, locations: v.locations }));
        return NextResponse.json({ choices });
    }
    const where = { connectionId: source.id, kind, ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { inn: { contains: q } }, { externalId: { contains: q, mode: 'insensitive' as const } }] } : {}) };
    const [rows, total, latest] = await Promise.all([prisma.enterpriseDataRecord.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (page - 1) * 25, take: 25, select: { id: true, kind: true, externalId: true, name: true, inn: true, kpp: true, archived: true, normalized: true, syncToSite: true, updatedAt: true } }), prisma.enterpriseDataRecord.count({ where }), kind === 'partner' ? prisma.partnerDirectoryImport.findFirst({where: {connectionId: source.id}, orderBy: {receivedAt: 'desc'}, select: {objectCount: true, receivedAt: true}}) : prisma.enterpriseDataImport.findFirst({ where: { connectionId: source.id }, orderBy: { messageNo: 'desc' }, select: { messageNo: true, objectCount: true, receivedAt: true } })]);
    const refs = await prisma.externalReference.findMany({ where: { connectionId: source.id, externalId: { in: rows.map(r => r.externalId) }, entityType: { in: ['product', 'edCustomer', 'edPoint', 'utPartnerPoint'] } }, select: { entityType: true, externalId: true, entityId: true, sourceData: true } });
    const ids = (type: string) => refs.filter(r => r.entityType === type).map(r => r.entityId);
    const [products, customers, points] = await Promise.all([
        prisma.product.findMany({ where: { storeId, id: { in: ids('product') } }, select: { id: true, canonicalName: true } }),
        prisma.customer.findMany({ where: { storeId, id: { in: ids('edCustomer') } }, select: { id: true, displayName: true } }),
        prisma.customerLocation.findMany({ where: { customer: { storeId }, id: { in: [...ids('edPoint'), ...ids('utPartnerPoint')] } }, select: { id: true, name: true } }),
    ]);
    const names = new Map([...products.map(p => [p.id, p.canonicalName] as const), ...customers.map(p => [p.id, p.displayName] as const), ...points.map(p => [p.id, p.name] as const)]);
    const linkedIds = rows.flatMap(r => (r.normalized as {counterpartyIds?: string[]}).counterpartyIds ?? []);
    const counterparties = kind === 'partner' ? await prisma.enterpriseDataRecord.findMany({where: {connectionId: source.id, kind: 'counterparty', externalId: {in: linkedIds}}, select: {externalId: true, name: true, inn: true}}) : [];
    return NextResponse.json({ counterparties, rows: rows.map(row => ({ ...row, links: refs.filter(r => r.externalId === row.externalId && (kind === 'product' && r.entityType === 'product' || kind === 'counterparty' && r.entityType === 'edCustomer' || kind === 'counterparty' && r.entityType === 'edPoint' || kind === 'partner' && r.entityType === 'utPartnerPoint')).map(r => ({ entityType: r.entityType, externalId: r.externalId, entityId: r.entityId, name: names.get(r.entityId) ?? 'Карточка недоступна', assignment: r.entityType === 'utPartnerPoint' ? r.sourceData : null })) })), total, page, latest, editable: auth.user.role === 'ADMIN' && source.sourceState === 'ACTIVE' && source.enabled });
}
export async function POST(request: Request, { params }: Context) {
    const auth = await requireApiUser(['ADMIN'], 'commerce-core');
    if ('response' in auth)
        return auth.response;
    const parsed = DirectoryAction.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
        return NextResponse.json({ error: 'invalid_input' }, { status: 400 });
    try {
        return NextResponse.json(await applyDirectoryAction({ storeId: auth.user.storeId, connectionId: params.id }, parsed.data, auth.user));
    }
    catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
        if (error instanceof IntegrationInputError)
            return NextResponse.json({ error: error.code }, { status: error.status });
        throw error;
    }
}
