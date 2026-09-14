import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Media storage port. Generated artifacts (invoice PDFs, later product images)
 * live behind this boundary so a deployment can swap the filesystem for object
 * storage (S3/MinIO) without touching domain code. The default implementation
 * writes under `MEDIA_ROOT` (dev: `<cwd>/.media`).
 *
 * For invoices the store is a CACHE, not the source of truth: the PDF is
 * regenerated deterministically from the invoice's immutable snapshot, so a
 * lost/rotated media file reproduces byte-identical content.
 */
export interface MediaStore {
  exists(key: string): Promise<boolean>
  get(key: string): Promise<Buffer | null>
  put(key: string, bytes: Buffer, contentType?: string): Promise<{ key: string }>
}

/** Reject traversal / absolute keys — media keys are relative slugs. */
function safeKey(key: string): string {
  const normalized = path.posix.normalize(key).replace(/^(\.\.(\/|\\|$))+/, '')
  if (normalized.startsWith('/') || normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new Error(`invalid media key: ${key}`)
  }
  return normalized
}

class FilesystemMediaStore implements MediaStore {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    return path.join(this.root, safeKey(key))
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key))
      return true
    } catch {
      return false
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key))
    } catch {
      return null
    }
  }

  async put(key: string, bytes: Buffer): Promise<{ key: string }> {
    const target = this.resolve(key)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, bytes)
    return { key: safeKey(key) }
  }
}

let cached: MediaStore | null = null

export function getMediaStore(): MediaStore {
  if (cached) return cached
  const root = process.env.MEDIA_ROOT || path.join(process.cwd(), '.media')
  cached = new FilesystemMediaStore(root)
  return cached
}

/** Test hook — override the media store (e.g. an in-memory fake). */
export function setMediaStore(store: MediaStore | null): void {
  cached = store
}
