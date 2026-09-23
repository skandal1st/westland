import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { SaxesParser } from 'saxes'

export const CHUNK_LIMIT = 20 * 1024 * 1024
export const FILE_LIMIT = 128 * 1024 * 1024
export const SESSION_LIMIT = 512 * 1024 * 1024
export { IntegrationInputError as ExchangeError } from '@/lib/integrations/errors'
import { IntegrationInputError as ExchangeError } from '@/lib/integrations/errors'
export type Chunk = { offset: number; size: number; sha256: string }
export type UploadFile = { id: string; name: string; size: number; chunks: Chunk[]; sha256?: string; kind?: 'catalog' | 'offers' | 'asset'; sealedAt?: string }
export type GenerationFile = { sessionId: string; id: string; name: string; size: number; sha256: string; kind: 'catalog' | 'offers' | 'asset' }
export const sha256 = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex')
function segment(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new ExchangeError('invalid_storage_identity', 400)
  return value
}
export function sourceDir(connectionId: string) { return path.join(process.env.ONEC_EXCHANGE_DIR || '/app/exchange', 'sources', segment(connectionId)) }
function fileDir(connectionId: string, sessionId: string, fileId: string) { return path.join(sourceDir(connectionId), segment(sessionId), segment(fileId)) }
function chunkPath(connectionId: string, sessionId: string, fileId: string, digest: string) { return path.join(fileDir(connectionId, sessionId, fileId), `${segment(digest)}.chunk`) }
export function sealedPath(connectionId: string, file: GenerationFile) { return path.join(fileDir(connectionId, file.sessionId, file.id), `${segment(file.sha256)}.sealed`) }
async function syncDirectory(dir: string) {
  if (process.platform === 'win32') return // Windows does not expose directory fsync through Node.
  const handle = await fs.open(dir, 'r'); try { await handle.sync() } finally { await handle.close() }
}
export async function storeChunk(connectionId: string, sessionId: string, fileId: string, bytes: Buffer) {
  const digest = sha256(bytes), dest = chunkPath(connectionId, sessionId, fileId, digest)
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const temp = `${dest}.${crypto.randomUUID()}.tmp`
  const handle = await fs.open(temp, 'wx')
  try {
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await fs.rename(temp, dest)
  } catch (error) { await fs.unlink(temp).catch(() => undefined); throw error }
  await syncDirectory(path.dirname(dest))
  return digest
}
export async function readLimitedBody(request: Request): Promise<Buffer> {
  const length = request.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > CHUNK_LIMIT)) throw new ExchangeError('chunk_too_large', 413)
  if (!request.body) throw new ExchangeError('empty_chunk', 400)
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > CHUNK_LIMIT) { await reader.cancel(); throw new ExchangeError('chunk_too_large', 413) }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  if (!size) throw new ExchangeError('empty_chunk', 400)
  return Buffer.concat(chunks, size)
}
async function xmlKind(filename: string, fullPath: string): Promise<'catalog' | 'offers' | 'asset'> {
  if (!filename.toLowerCase().endsWith('.xml')) return 'asset'
  const parser = new SaxesParser({ xmlns: true })
  let root = '', catalog = false, offers = false
  parser.on('error', () => { throw new ExchangeError('incomplete_or_invalid_xml') })
  parser.on('doctype', () => { throw new ExchangeError('xml_doctype_not_allowed') })
  parser.on('opentag', node => {
    if (!root) root = node.local
    if (node.local === 'Каталог') catalog = true
    if (node.local === 'ПакетПредложений' || node.local === 'ИзмененияПакетаПредложений') offers = true
  })
  try {
    for await (const text of createReadStream(fullPath, { encoding: 'utf8' })) parser.write(text)
    parser.close()
  } catch (error) { if (error instanceof ExchangeError) throw error; throw new ExchangeError('incomplete_or_invalid_xml') }
  if (root !== 'КоммерческаяИнформация' || catalog === offers) throw new ExchangeError('unsupported_commerceml_file')
  return catalog ? 'catalog' : 'offers'
}
export async function sealFile(connectionId: string, sessionId: string, file: UploadFile): Promise<UploadFile> {
  const dir = fileDir(connectionId, sessionId, file.id), temp = path.join(dir, `${crypto.randomUUID()}.tmp`)
  const handle = await fs.open(temp, 'wx'), hash = crypto.createHash('sha256')
  let size = 0
  try {
    try {
      for (const chunk of file.chunks) {
        if (chunk.offset !== size) throw new ExchangeError('corrupt_chunk_journal')
        const bytes = await fs.readFile(chunkPath(connectionId, sessionId, file.id, chunk.sha256))
        if (bytes.length !== chunk.size || sha256(bytes) !== chunk.sha256) throw new ExchangeError('corrupt_chunk_bytes')
        await handle.writeFile(bytes); hash.update(bytes); size += bytes.length
      }
      await handle.sync()
    } finally { await handle.close() }
    if (size !== file.size) throw new ExchangeError('corrupt_file_size')
    const kind = await xmlKind(file.name, temp), digest = hash.digest('hex')
    await fs.rename(temp, path.join(dir, `${digest}.sealed`)); await syncDirectory(dir)
    return { ...file, kind, sha256: digest, sealedAt: new Date().toISOString() }
  } catch (error) { await fs.unlink(temp).catch(() => undefined); throw error }
}
export async function readGenerationFile(connectionId: string, file: GenerationFile): Promise<string> {
  const bytes = await fs.readFile(sealedPath(connectionId, file))
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new ExchangeError('generation_file_integrity_failed')
  return bytes.toString('utf8')
}
