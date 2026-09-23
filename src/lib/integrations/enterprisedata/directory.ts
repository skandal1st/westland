import { assertCapability } from '@/lib/capabilities'
import { z } from 'zod';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordAudit } from '@/lib/audit';
import { fingerprint } from '@/lib/catalog/normalize';
import { applyProductSnapshotInTransaction } from '@/lib/catalog/import';
import { saveSourceMapping } from '../mappings';
import { IntegrationInputError } from '../errors';
import { inspectMessage, ED_NS } from './message';
import { DirectoryData, parseDirectoryObject, type DirectoryDataType } from './directory-parser';
import type { SiteBinding } from './site-orders';
import type { TransportPeer } from './http-files';
type Tx = Prisma.TransactionClient;
const bad = (code: string, status = 409): never => { throw new IntegrationInputError(code, status); };
const json = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v));
async function source(binding: SiteBinding, tx: Tx) {
    await tx.$queryRaw `SELECT id FROM "IntegrationConnection" WHERE id = ${binding.connectionId} FOR UPDATE`;
    const row = await tx.integrationConnection.findFirst({ where: { id: binding.connectionId, storeId: binding.storeId, provider: 'ONE_C', sourceState: 'ACTIVE', enabled: true } });
    if (!row)
        return bad('ed_source_inactive');
    return row;
}
async function projectProduct(binding: SiteBinding, data: DirectoryDataType, tx: Tx) {
    const ref = await tx.externalReference.findUnique({ where: { connectionId_entityType_externalId: { connectionId: binding.connectionId, entityType: 'product', externalId: data.externalId } } });
    const prior = ref?.sourceData && typeof ref.sourceData === 'object' && !Array.isArray(ref.sourceData) ? ref.sourceData : {};
    // Merge only fields present in ED; preserve CommerceML unit, packaging and identifiers.
    const variant = ref ? await tx.productVariant.findFirst({ where: { productId: ref.entityId, isDefault: true }, include: { identifiers: true } }) : null;
    const payload = { ...prior, ...(variant ? { packaging: variant.packaging, unitsPerPack: variant.unitsPerPack, identifiers: variant.identifiers.map(v => ({ type: v.type, value: v.value })) } : {}), externalId: data.externalId, name: data.name, sku: data.article || data.code || ref?.externalCode || data.externalId,
        ...(data.baseUnit ? { baseUnit: data.baseUnit } : {}), ...(data.description !== undefined ? { description: data.description } : {}), ...(data.archived !== undefined ? { archived: data.archived } : {}), providerVersion: 'EnterpriseData/1.20' };
    return applyProductSnapshotInTransaction({ ...binding, payload }, tx);
}
/** DB commit precedes protocol ACK. Replay repairs a crash between DB and file journal. */
export async function importDirectory(binding: SiteBinding, peer: TransportPeer, xml: Buffer, db: PrismaClient = prisma) {
  assertCapability('commerce-core')

    const message = inspectMessage(xml), c = message.confirmation;
    if (message.format !== ED_NS || !message.hasBody || c.from !== peer.from || c.to !== peer.to || c.plan !== peer.plan || c.messageNo < 1)
        bad('ed_directory_peer_mismatch');
    if (!message.objects.length || message.objects.length > 5000)
        bad('ed_directory_object_count');
    const objects = message.objects.map(parseDirectoryObject), ids = objects.map(o => o.data.kind + ':' + o.data.externalId);
    if (new Set(ids).size !== ids.length)
        bad('ed_directory_duplicate_identity');
    return db.$transaction(async (tx) => {
        await source(binding, tx);
        const prior = await tx.enterpriseDataImport.findUnique({ where: { connectionId_messageNo: { connectionId: binding.connectionId, messageNo: c.messageNo } } });
        if (prior) {
            if (prior.sha256 !== message.sha256)
                bad('ed_directory_message_conflict');
            return { sha256: prior.sha256, objects: prior.objectCount, reused: true };
        }
        const latest = await tx.enterpriseDataImport.findFirst({ where: { connectionId: binding.connectionId }, orderBy: { messageNo: 'desc' } });
        if (latest && latest.messageNo >= c.messageNo)
            bad('ed_directory_message_stale');
        for (const object of objects) {
            const data = object.data, where = { connectionId_kind_externalId: { connectionId: binding.connectionId, kind: data.kind, externalId: data.externalId } };
            const current = await tx.enterpriseDataRecord.findUnique({ where });
            const merged = DirectoryData.parse({ ...current?.normalized as Record<string, unknown> ?? {}, ...json(data) as Record<string, unknown> });
            const row = await tx.enterpriseDataRecord.upsert({ where, create: { connectionId: binding.connectionId, kind: data.kind, externalId: data.externalId, name: data.name, inn: merged.inn ?? '', kpp: merged.kpp ?? '', archived: merged.archived ?? false, normalized: json(merged), raw: json(object.raw), fingerprint: fingerprint(merged), messageNo: c.messageNo }, update: { name: data.name, inn: merged.inn ?? '', kpp: merged.kpp ?? '', archived: merged.archived ?? false, normalized: json(merged), raw: json(object.raw), fingerprint: fingerprint(merged), messageNo: c.messageNo } });
            if (row.syncToSite && row.kind === 'product' && row.fingerprint !== current?.fingerprint)
                await projectProduct(binding, merged, tx);
        }
        await tx.enterpriseDataImport.create({ data: { connectionId: binding.connectionId, messageNo: c.messageNo, sha256: message.sha256, objectCount: objects.length } });
        return { sha256: message.sha256, objects: objects.length, reused: false };
    }, { timeout: 60000 });
}
export const DirectoryAction = z.discriminatedUnion('action', [
    z.object({ action: z.literal('linkCustomer'), recordId: z.string().min(1), entityId: z.string().min(1) }).strict(),
    z.object({ action: z.literal('syncProduct'), recordId: z.string().min(1), entityId: z.string().optional() }).strict(),
    z.object({ action: z.literal('stopProductSync'), recordId: z.string().min(1) }).strict(),
    z.object({ action: z.literal('createPoint'), recordId: z.string().min(1), customerId: z.string().min(1), locationId: z.string().min(1).optional(), name: z.string().trim().min(1).max(200), city: z.string().trim().min(1).max(200), address: z.string().trim().min(1).max(2000), manualAssignment: z.object({ confirmed: z.literal(true), reason: z.string().trim().min(5).max(1000) }).strict().optional() }).strict(),
]).refine(v => v.action !== 'createPoint' || v.city.length + 2 + v.address.length <= 255, 'delivery_address_too_long');
export async function applyDirectoryAction(binding: SiteBinding, input: z.infer<typeof DirectoryAction>, actor: {
    id: string;
    email: string;
}, db: PrismaClient = prisma) {
  assertCapability('commerce-core')

    const parsed = DirectoryAction.safeParse(input);
    if (!parsed.success) bad('invalid_input', 400);
    input = parsed.data!;
    return db.$transaction(async (tx) => {
        await source(binding, tx);
        const row = await tx.enterpriseDataRecord.findFirst({ where: { id: input.recordId, connectionId: binding.connectionId } });
        if (!row)
            bad('ed_directory_record_missing', 404);
        const record = row!, data = DirectoryData.parse(record.normalized);
        if (input.action !== 'stopProductSync' && record.archived)
            bad('ed_directory_record_archived');
        let entityId: string | undefined;
        if (input.action === 'linkCustomer') {
            if (record.kind !== 'counterparty')
                bad('ed_directory_kind_mismatch');
            const customer = await tx.customer.findFirst({ where: { id: input.entityId, storeId: binding.storeId } });
            if (!customer)
                bad('mapping_target_not_found', 404);
            if (!record.inn || customer!.inn !== record.inn || (customer!.kpp ?? '') !== record.kpp)
                bad('ed_customer_requisites_mismatch');
            await saveSourceMapping(binding.storeId, binding.connectionId, { entityType: 'edCustomer', entityId: input.entityId, externalId: record.externalId }, actor, tx);
            entityId = input.entityId;
        }
        else if (input.action === 'syncProduct') {
            if (record.kind !== 'product')
                bad('ed_directory_kind_mismatch');
            if (input.entityId)
                await saveSourceMapping(binding.storeId, binding.connectionId, { entityType: 'product', entityId: input.entityId, externalId: record.externalId }, actor, tx);
            entityId = (await projectProduct(binding, data, tx)).productId;
            await tx.enterpriseDataRecord.update({ where: { id: record.id }, data: { syncToSite: true } });
        }
        else if (input.action === 'stopProductSync') {
            if (record.kind !== 'product')
                bad('ed_directory_kind_mismatch');
            await tx.enterpriseDataRecord.update({ where: { id: record.id }, data: { syncToSite: false } });
        }
        else {
            if (!['counterparty', 'partner'].includes(record.kind))
                bad('ed_directory_kind_mismatch');
            if (input.manualAssignment && record.kind !== 'partner') bad('ed_directory_kind_mismatch');
            const pointType = record.kind === 'partner' ? 'utPartnerPoint' : 'edPoint';
            const customer = await tx.customer.findFirst({ where: { id: input.customerId, storeId: binding.storeId } });
            if (!customer)
                bad('mapping_target_not_found', 404);
            const existing = await tx.externalReference.findUnique({ where: { connectionId_entityType_externalId: { connectionId: binding.connectionId, entityType: pointType, externalId: record.externalId } } });
            if (existing) {
                const point = await tx.customerLocation.findUnique({ where: { id: existing.entityId } });
                if (point?.customerId !== input.customerId || (input.locationId && input.locationId !== existing.entityId))
                    bad('ed_point_already_linked');
                entityId = existing.entityId;
            }
            else {
                let assignment: Prisma.InputJsonValue | undefined;
                if (record.kind === 'partner') {
                    const mapped = await tx.externalReference.findFirst({ where: { connectionId: binding.connectionId, entityType: 'edCustomer', entityId: input.customerId,
                        ...(!input.manualAssignment ? { externalId: { in: data.counterpartyIds ?? [] } } : {}) } });
                    if (!mapped) bad(input.manualAssignment ? 'partner_customer_mapping_required' : 'partner_customer_link_required');
                    assignment = json({ origin: input.manualAssignment ? 'MANUAL' : 'ONE_C', customerId: input.customerId, customerName: customer!.displayName,
                        counterpartyId: mapped!.externalId, partnerId: record.externalId, sourceCounterpartyIds: data.counterpartyIds ?? [], sourceFingerprint: record.fingerprint,
                        reason: input.manualAssignment?.reason ?? null, actorId: actor.id, assignedAt: new Date().toISOString() });
                }
                if (!input.locationId && await tx.user.count({ where: { storeId: binding.storeId, customerId: input.customerId, role: 'BUYER', deliveryPointsRestricted: false } }))
                    bad('ed_point_restrictions_required');
                const point = input.locationId
                    ? await tx.customerLocation.findFirst({ where: { id: input.locationId, customerId: input.customerId } })
                    : await tx.customerLocation.create({ data: { customerId: input.customerId, name: input.name, city: input.city, address: input.address } });
                if (!point) return bad('mapping_target_not_found', 404);
                if (await tx.externalReference.findFirst({ where: { connectionId: binding.connectionId, entityType: pointType, entityId: point.id } })) bad('ed_point_already_linked');
                entityId = point.id;
                await tx.externalReference.create({ data: { connectionId: binding.connectionId, entityType: pointType, externalId: record.externalId, entityId: point.id, ...(assignment ? { sourceData: assignment } : {}) } });
                if (assignment) await recordAudit(tx, { storeId: binding.storeId, actor, action: 'PartnerPointAssigned', targetType: 'CustomerLocation', targetId: point.id, metadata: assignment });
            }
            // No user grants: moderator assigns access via the existing point assignment screen.
        }
        await recordAudit(tx, { storeId: binding.storeId, actor, action: 'EnterpriseDataDirectoryMapped', targetType: 'IntegrationConnection', targetId: binding.connectionId, metadata: { action: input.action, recordId: record.id, entityId } });
        return { ok: true, entityId };
    }, { timeout: 30000 });
}
