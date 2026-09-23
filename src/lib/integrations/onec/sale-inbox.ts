import { assertCapability } from '@/lib/capabilities'
import { SaxesParser } from 'saxes'
import { z } from 'zod'
import type { PrismaClient } from '@prisma/client'
import { prisma as db } from '@/lib/db'
import { recordAudit } from '@/lib/audit'
import { authenticateSession, type SessionAuthority } from './ledger'
import { CHUNK_LIMIT, ExchangeError, sha256 } from './storage'
import { safeFilename } from './exchange'

// Capture must be explicitly enabled per source while its actual UT dialect is verified.
export const SaleImportSchema = z.object({ enabled: z.literal(true), mode: z.literal('REVIEW') }).strict()
export function saleImportProfile(config: unknown) {
  if (!SaleImportSchema.safeParse((config as { saleImport?: unknown } | null)?.saleImport).success)
    throw new ExchangeError('sale_ack_import_not_configured', 503)
}

/** Validate framing only. Fields/statuses are not yet interpreted as business decisions. */
export function inspectSaleXml(bytes: Buffer) {
  if (!bytes.length || bytes.length > CHUNK_LIMIT) throw new ExchangeError('sale_file_too_large', 413)
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new ExchangeError('sale_utf8_required', 400) }
  const xml = bytes.toString('utf8'), parser = new SaxesParser({ xmlns: true })
  const path: string[] = []; let nodes = 0, documents = 0, rootNamespace = ''
  parser.on('error', () => { throw new ExchangeError('sale_complete_xml_required', 400) })
  parser.on('doctype', () => { throw new ExchangeError('xml_doctype_not_allowed', 400) })
  parser.on('xmldecl', value => { if (value.encoding && !/^utf-?8$/i.test(value.encoding)) throw new ExchangeError('sale_utf8_required', 400) })
  parser.on('opentag', node => {
    path.push(node.local); nodes++
    if (nodes > 100_000 || path.length > 32) throw new ExchangeError('sale_xml_limit_exceeded', 413)
    if (path.length === 1) {
      rootNamespace = node.uri
      if (node.local !== 'КоммерческаяИнформация' || !['', 'urn:1C.ru:commerceml_2', 'urn:1C.ru:commerceml_210'].includes(node.uri))
        throw new ExchangeError('sale_commerceml_required', 400)
    } else if (node.uri !== rootNamespace) throw new ExchangeError('sale_namespace_mismatch', 400)
    if (path.length === 2 && !['Документ', 'Контейнер'].includes(node.local)) throw new ExchangeError('sale_documents_required', 400)
    if (node.local === 'Документ') {
      if (!(path.length === 2 || (path.length === 3 && path[1] === 'Контейнер'))) throw new ExchangeError('sale_document_position_invalid', 400)
      if (++documents > 1000) throw new ExchangeError('sale_too_many_documents', 413)
    }
  })
  parser.on('closetag', () => { path.pop() })
  parser.write(xml).close()
  return { xml, documentCount: documents }
}

/** Acknowledge durable receipt, not approval, payment or matching commercial terms.
 * Repeated complete files in this or another session have one source-bound receipt.
 * Fragmented XML fails explicitly until a verified chunked UT dialect is available. */
export async function receiveSaleFile(authority: SessionAuthority, filename: string, bytes: Buffer, client: PrismaClient = db) {
  assertCapability('commerce-core')

  if (!safeFilename(filename) || !filename.toLowerCase().endsWith('.xml')) throw new ExchangeError('invalid_filename', 400)
  const parsed = inspectSaleXml(bytes), digest = sha256(bytes)
  return client.$transaction(async tx => {
    const initial = await tx.onecExchangeSession.findUnique({ where: { id: authority.sessionId }, select: { connectionId: true } })
    if (!initial) throw new ExchangeError('session_expired_or_unknown', 401)
    await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${initial.connectionId} FOR UPDATE`
    const session = await authenticateSession(authority, tx)
    if (session.closedAt || !session.connection.enabled || session.connection.sourceState !== 'ACTIVE') throw new ExchangeError('source_not_active', 503)
    saleImportProfile(session.connection.config)
    const existing = await tx.onecSaleInbox.findUnique({ where: { connectionId_sha256: { connectionId: session.connectionId, sha256: digest } } })
    if (existing) {
      if (existing.bytes !== bytes.length || existing.xml !== parsed.xml || sha256(existing.xml) !== digest) throw new ExchangeError('sale_inbox_corrupt')
      return { id: existing.id, status: existing.status, duplicate: true }
    }
    const usage = await tx.onecSaleInbox.aggregate({ where: { sessionId: session.id }, _sum: { bytes: true }, _count: true })
    const pending = await tx.onecSaleInbox.aggregate({ where: { connectionId: session.connectionId, status: 'PENDING_REVIEW' }, _sum: { bytes: true }, _count: true })
    if (usage._count >= 128 || (usage._sum.bytes ?? 0) + bytes.length > 64 * 1024 * 1024
      || pending._count >= 1024 || (pending._sum.bytes ?? 0) + bytes.length > 256 * 1024 * 1024) throw new ExchangeError('sale_inbox_limit_exceeded', 413)
    const receipt = await tx.onecSaleInbox.create({ data: { connectionId: session.connectionId, sessionId: session.id,
      filename, sha256: digest, xml: parsed.xml, bytes: bytes.length, documentCount: parsed.documentCount } })
    await recordAudit(tx, { storeId: authority.storeId, actor: null, action: 'OnecSaleFileReceived', targetType: 'OnecSaleInbox', targetId: receipt.id,
      metadata: { connectionId: session.connectionId, sha256: digest, documentCount: parsed.documentCount, status: receipt.status } })
    return { id: receipt.id, status: receipt.status, duplicate: false }
  }, { timeout: 30_000 })
}
