import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

/** Private artifact cache. Invoice snapshots in PostgreSQL remain the source of truth. */
export interface MediaStore {
  exists(key: string): Promise<boolean>
  get(key: string): Promise<Buffer | null>
  put(key: string, bytes: Buffer, contentType?: string): Promise<{ key: string }>
}

function safeKey(key: string): string {
  // Validate before normalization: never silently turn traversal into another key.
  if (!key || !/^[a-zA-Z0-9_./-]+$/.test(key) || key.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('invalid media key')
  }
  return key
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

class FilesystemMediaStore implements MediaStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    return path.join(this.root, safeKey(key))
  }

  async exists(key: string): Promise<boolean> {
    try { await fs.access(this.resolve(key)); return true }
    catch (error) { if (missing(error)) return false; throw error }
  }

  async get(key: string): Promise<Buffer | null> {
    try { return await fs.readFile(this.resolve(key)) }
    catch (error) { if (missing(error)) return null; throw error }
  }

  async put(key: string, bytes: Buffer): Promise<{ key: string }> {
    const target = this.resolve(key)
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    // Same-directory rename publishes only a complete file, including concurrent renders.
    const temporary = target + '.' + randomUUID() + '.tmp'
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, target); break }
        catch (error) {
          // Windows briefly locks a destination held by another reader/rename.
          const retry = process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
          if (!retry || attempt >= 5) throw error
          await delay(20 * 2 ** attempt)
        }
      }
    } finally {
      await fs.unlink(temporary).catch(error => { if (!missing(error)) throw error })
    }
    return { key }
  }
}

let cached: MediaStore | null = null

export function getMediaStore(): MediaStore {
  if (cached) return cached
  const root = path.resolve(process.env.MEDIA_ROOT || path.join(process.cwd(), '.media'))
  for (const directory of ['public', '.next']) {
    const relative = path.relative(path.join(process.cwd(), directory), root)
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('MEDIA_ROOT must be outside public and Next.js assets')
    }
  }
  cached = new FilesystemMediaStore(root)
  return cached
}

/** Test hook — override the media store (e.g. an in-memory fake). */
export function setMediaStore(store: MediaStore | null): void { cached = store }
