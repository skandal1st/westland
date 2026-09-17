import fs from 'node:fs/promises'
import path from 'node:path'
import { logger } from '@/lib/logger'
import {
  COOKIE_NAME,
  checkCredentials,
  emptySaleDocument,
  mintSession,
  parseBasicAuth,
  readCookie,
  safeFilename,
  verifySession,
} from '@/lib/integrations/onec/exchange'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Received exchange files are transient (parsed at import, then superseded), so
// they live in a writable volume, not the read-only deployment mount.
const EXCHANGE_DIR = process.env.ONEC_EXCHANGE_DIR || '/app/exchange'
const FILE_LIMIT = 20 * 1024 * 1024 // bytes per file chunk 1C may upload

function text(body: string, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  })
}

function catalogDir(): string {
  return path.join(EXCHANGE_DIR, 'catalog')
}

/**
 * 1C "Обмен с сайтом" (CommerceML) exchange endpoint.
 *
 * Transport milestone: implements the full session protocol (checkauth → init →
 * file → import for catalog; init/query/success for orders), Basic-auth with an
 * HMAC session cookie, and durable receipt of uploaded files into a writable
 * volume. The CommerceML parser, staging→import wiring and order export mapping
 * land against a real sample — `import`/`query` acknowledge cleanly until then.
 */
async function handle(request: Request): Promise<Response> {
  const expected = { user: process.env.ONEC_EXCHANGE_USER, pass: process.env.ONEC_EXCHANGE_PASSWORD }
  const secret = process.env.NEXTAUTH_SECRET
  if (!expected.user || !expected.pass || !secret) {
    return text('failure\nexchange endpoint is not configured', 503)
  }

  const url = new URL(request.url)
  const type = url.searchParams.get('type') ?? ''
  const mode = url.searchParams.get('mode') ?? ''

  // Step 1: authenticate with Basic and hand back a session cookie.
  if (mode === 'checkauth') {
    const creds = parseBasicAuth(request.headers.get('authorization'))
    if (!checkCredentials(creds, expected)) return text('failure\nauthentication failed', 401)
    const token = mintSession(secret)
    return text(`success\n${COOKIE_NAME}\n${token}`, 200, {
      'set-cookie': `${COOKIE_NAME}=${token}; Path=/api/integrations/1c; HttpOnly; SameSite=Lax`,
    })
  }

  // Every later step must present the session cookie (or re-send Basic).
  const cookie = readCookie(request.headers.get('cookie'), COOKIE_NAME)
  const basic = parseBasicAuth(request.headers.get('authorization'))
  if (!verifySession(secret, cookie) && !checkCredentials(basic, expected)) {
    return text('failure\nnot authorized', 401)
  }

  if (type === 'catalog') return handleCatalog(request, url, mode)
  if (type === 'sale') return handleSale(mode)
  return text('failure\nunsupported type', 400)
}

async function handleCatalog(request: Request, url: URL, mode: string): Promise<Response> {
  const dir = catalogDir()
  switch (mode) {
    case 'init': {
      // A new session starts fresh so a failed run cannot mix with the next.
      await fs.rm(dir, { recursive: true, force: true })
      await fs.mkdir(dir, { recursive: true })
      return text(`zip=no\nfile_limit=${FILE_LIMIT}`)
    }
    case 'file': {
      const name = safeFilename(url.searchParams.get('filename'))
      if (!name) return text('failure\ninvalid filename', 400)
      await fs.mkdir(dir, { recursive: true })
      const bytes = Buffer.from(await request.arrayBuffer())
      await fs.appendFile(path.join(dir, name), bytes) // 1C may chunk one file across calls
      return text('success')
    }
    case 'import': {
      // Parser + staging→pipeline wiring land with a real CommerceML sample.
      const name = safeFilename(url.searchParams.get('filename'))
      logger.info('1c.exchange.catalog.import received (parser pending)', { filename: name })
      return text('success')
    }
    case 'deactivate':
    case 'complete':
      return text('success')
    default:
      return text('failure\nunknown catalog mode', 400)
  }
}

function handleSale(mode: string): Response {
  switch (mode) {
    case 'init':
      return text(`zip=no\nfile_limit=${FILE_LIMIT}`)
    case 'query':
      // Order export → CommerceML mapping lands later; a well-formed empty
      // document is a valid "no orders" reply that lets 1C finish the session.
      return text(emptySaleDocument())
    case 'success':
      return text('success')
    default:
      return text('failure\nunknown sale mode', 400)
  }
}

export const GET = handle
export const POST = handle
