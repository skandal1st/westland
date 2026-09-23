import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
export const ASSET_LIMIT = 8 * 1024 * 1024
const assetName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/
function assetDir(storeId: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(storeId)) throw new Error('invalid_store')
  // The exchange volume is included in deployment backups; invoice cache is not durable.
  return path.join(process.env.ONEC_EXCHANGE_DIR || '/app/exchange', 'content-assets', storeId)
}
export async function saveBannerAsset(storeId: string, bytes: Buffer) {
  if (!bytes.length || bytes.length > ASSET_LIMIT) throw new Error('image_too_large')
  let converted: Buffer
  try {
    const decoder = sharp(bytes, { limitInputPixels: 25000000, failOn: 'warning' })
    const metadata = await decoder.metadata()
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('invalid_image')
    converted = await decoder.rotate().resize({ width: 2560, height: 1440, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88 }).toBuffer()
  } catch { throw new Error('invalid_image') }
  const id = randomUUID() + '.webp'
  const dir = assetDir(storeId)
  await fs.mkdir(dir, { recursive: true })
  const file = await fs.open(path.join(dir, id), 'wx')
  try { await file.writeFile(converted); await file.sync() } finally { await file.close() }
  return '/api/content/assets/' + id
}
export async function readBannerAsset(storeId: string, id: string) {
  if (!assetName.test(id)) return null
  try { return await fs.readFile(path.join(assetDir(storeId), id)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
export function validBannerImage(value: string) {
  if (value.startsWith('/api/content/assets/')) return assetName.test(value.slice('/api/content/assets/'.length))
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password } catch { return false }
}
/** Bound the stream even when Content-Length is absent or incorrect. */
export async function readImageBody(request: Request) {
  if (Number(request.headers.get('content-length')) > ASSET_LIMIT) throw new Error('image_too_large')
  if (!request.body) throw new Error('invalid_image')
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > ASSET_LIMIT) { await reader.cancel(); throw new Error('image_too_large') }; chunks.push(chunk.value) } }
  finally { reader.releaseLock() }
  return Buffer.concat(chunks)
}
