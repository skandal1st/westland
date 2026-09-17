import crypto from 'node:crypto'
import path from 'node:path'

/**
 * 1C "Обмен с сайтом" (CommerceML) transport helpers — pure and testable.
 *
 * In this protocol 1C is the CLIENT and our site is the SERVER: 1C drives a
 * session (checkauth → init → file → import for catalog; query → success for
 * orders). checkauth authenticates with HTTP Basic against credentials WE own
 * (env / secret storage, never the connection config blob); it returns a cookie
 * that authorises the rest of the session. We mint that cookie as a stateless
 * HMAC token so no session table is needed.
 *
 * The CommerceML payload schema (import.xml / offers.xml) is dialect-specific
 * and deliberately NOT parsed here — that mapping lands with a real sample.
 */

export const COOKIE_NAME = 'WSCEXAUTH'

export type Credentials = { user: string; pass: string }

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/** Parse an `Authorization: Basic ...` header into credentials, or null. */
export function parseBasicAuth(header: string | null | undefined): Credentials | null {
  if (!header || !/^Basic /i.test(header)) return null
  let decoded: string
  try {
    decoded = Buffer.from(header.replace(/^Basic /i, ''), 'base64').toString('utf8')
  } catch {
    return null
  }
  const sep = decoded.indexOf(':')
  if (sep < 0) return null
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) }
}

/** Constant-time credential check against the configured exchange login. */
export function checkCredentials(creds: Credentials | null, expected: Partial<Credentials>): boolean {
  if (!creds || !expected.user || !expected.pass) return false
  // Evaluate both comparisons regardless so timing does not leak which field failed.
  const userOk = timingSafeEqualStr(creds.user, expected.user)
  const passOk = timingSafeEqualStr(creds.pass, expected.pass)
  return userOk && passOk
}

/** Read a single cookie value from a raw Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

/** Mint a stateless HMAC session token: `1c.<expiryMs>.<sig>`. */
export function mintSession(secret: string, ttlMs = 6 * 60 * 60 * 1000, now = Date.now()): string {
  const payload = `1c.${now + ttlMs}`
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

/** Verify a session token's signature and expiry. */
export function verifySession(secret: string, token: string | null | undefined, now = Date.now()): boolean {
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 3) return false
  const payload = `${parts[0]}.${parts[1]}`
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
  if (!timingSafeEqualStr(parts[2], expected)) return false
  const exp = Number(parts[1])
  return Number.isFinite(exp) && exp > now
}

/**
 * Sanitise a 1C-supplied filename to a bare basename, rejecting traversal.
 * 1C sends names like `import___1.xml`, `offers___1.xml`, `import_files/...`.
 * We keep only the basename and allow a safe character set.
 */
export function safeFilename(name: string | null | undefined): string | null {
  if (!name) return null
  const base = path.basename(name.replace(/\\/g, '/'))
  if (!base || base === '.' || base === '..') return null
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return null
  return base
}

/** An empty but well-formed CommerceML document — a valid "no orders" reply. */
export function emptySaleDocument(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace('T', ' ')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<КоммерческаяИнформация ВерсияСхемы="2.05" ДатаФормирования="${stamp}">\n` +
    '</КоммерческаяИнформация>\n'
  )
}
