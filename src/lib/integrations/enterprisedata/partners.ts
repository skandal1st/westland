import { assertCapability } from '@/lib/capabilities'
import { z } from 'zod'
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { IntegrationInputError } from '../errors'
import { digest } from './message'
import type { SiteBinding } from './site-orders'

const guid = z.string().uuid().transform(v => v.toLowerCase()).refine(v => v !== '00000000-0000-0000-0000-000000000000')
export const PartnerSnapshot = z.object({
  format: z.literal('AXIMA.Partners/1'), connectionId: z.string().min(1).max(100), batchId: guid,
  exportedAt: z.string().datetime(),
  partners: z.array(z.object({
    externalId: guid, name: z.string().trim().min(1).max(2000), code: z.string().max(200), archived: z.boolean(),
    contacts: z.array(z.object({ kind: z.string().max(200), label: z.string().max(2000), display: z.string().max(65536), city: z.string().max(2000) }).strict()).max(100),
    counterpartyIds: z.array(guid).max(500),
  }).strict()).min(1).max(500),
}).strict()
export const MAX_PARTNER_BYTES = 4 * 1024 * 1024
const bad = (code: string): never => { throw new IntegrationInputError(code, 409) }
export async function importPartners(binding: SiteBinding, bytes: Buffer, actor: {id: string; email: string}, db: PrismaClient = prisma) {
  assertCapability('commerce-core')

  if (!bytes.length || bytes.length > MAX_PARTNER_BYTES) throw new IntegrationInputError('partner_file_size', 413)
  let input: z.infer<typeof PartnerSnapshot>
  try { input = PartnerSnapshot.parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/^\uFEFF/, ''))) }
  catch { throw new IntegrationInputError('partner_file_invalid', 400) }
  if (input.connectionId !== binding.connectionId) bad('partner_source_mismatch')
  if (Date.parse(input.exportedAt) > Date.now() + 300000) bad('partner_future_snapshot')
  if (new Set(input.partners.map(p => p.externalId)).size !== input.partners.length || input.partners.some(p => new Set(p.counterpartyIds).size !== p.counterpartyIds.length)) bad('partner_duplicate_identity')
  const hash = digest(bytes)
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${binding.connectionId} FOR UPDATE`
    const source = await tx.integrationConnection.findFirst({where: {id: binding.connectionId, storeId: binding.storeId, provider: 'ONE_C', sourceState: 'ACTIVE', enabled: true}})
    if (!source) bad('ed_source_inactive')
    const old = await tx.partnerDirectoryImport.findUnique({where: {connectionId_batchId: {connectionId: binding.connectionId, batchId: input.batchId}}})
    if (old) {
      if (old.sha256 !== hash) bad('partner_batch_conflict')
      return {ok: true, reused: true, objects: old.objectCount}
    }
    for (const partner of input.partners) {
      const where = {connectionId_kind_externalId: {connectionId: binding.connectionId, kind: 'partner', externalId: partner.externalId}}
      const prior = await tx.enterpriseDataRecord.findUnique({where})
      const previous = prior?.normalized as {sourceExportedAt?: string} | undefined
      const normalized = {...partner, kind: 'partner', sourceExportedAt: input.exportedAt, contacts: partner.contacts.map(c => ({...c, value: c.display}))}
      const fingerprint = digest(JSON.stringify(normalized))
      if (previous?.sourceExportedAt && (Date.parse(previous.sourceExportedAt) > Date.parse(input.exportedAt) || previous.sourceExportedAt === input.exportedAt && prior!.fingerprint !== fingerprint)) bad('partner_snapshot_stale')
      const values = {name: partner.name, archived: partner.archived, normalized: normalized as Prisma.InputJsonValue, raw: partner as Prisma.InputJsonValue, fingerprint}
      await tx.enterpriseDataRecord.upsert({where, create: {...values, connectionId: binding.connectionId, kind: 'partner', externalId: partner.externalId, messageNo: 0}, update: values})
    }
    await tx.partnerDirectoryImport.create({data: {connectionId: binding.connectionId, batchId: input.batchId, sha256: hash, objectCount: input.partners.length, exportedAt: new Date(input.exportedAt)}})
    await recordAudit(tx, {storeId: binding.storeId, actor, action: 'PartnerDirectoryImported', targetType: 'IntegrationConnection', targetId: binding.connectionId, metadata: {batchId: input.batchId, objects: input.partners.length, sha256: hash}})
    return {ok: true, reused: false, objects: input.partners.length}
  }, {timeout: 60000})
}
