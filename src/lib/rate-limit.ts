import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

/** Single-process fixed windows. Denied attempts never extend the deadline. */
type Bucket = { count: number; resetAt: number }
const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 10_000
let nextSweepAt = 0

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now()
  if (now >= nextSweepAt) {
    for (const [entry, bucket] of Array.from(buckets)) if (now >= bucket.resetAt) buckets.delete(entry)
    nextSweepAt = now + 60_000
  }
  const bucket = buckets.get(key)
  if (!bucket || now >= bucket.resetAt) {
    // Fail closed at capacity: never evict a live limit to admit attacker keys.
    if (!bucket && buckets.size >= MAX_BUCKETS) return { ok: false, retryAfterMs: Math.max(1, nextSweepAt - now) }
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfterMs: 0 }
  }
  if (bucket.count >= limit) return { ok: false, retryAfterMs: bucket.resetAt - now }
  bucket.count += 1
  return { ok: true, retryAfterMs: 0 }
}

/**
 * One trusted nginx directly in front of a loopback-only app. Existing nginx
 * appends its peer to XFF; new installs overwrite XFF. In both cases the last
 * entry is authoritative. Do not deploy this behind an unconfigured proxy chain.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')
  const address = (forwarded !== null ? forwarded.split(',').at(-1) : headers.get('x-real-ip'))?.trim()
  if (!address || address.includes('%') || !isIP(address)) return 'unknown'
  // Canonical IPv6 avoids separate counters for equivalent textual spellings.
  return isIP(address) === 6 ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address
}

/** Count synchronously before DB/bcrypt, including concurrent/invalid logins. */
export function loginRateLimit(ip: string, email: string): { ok: boolean; retryAfterMs: number } {
  const ipLimit = rateLimit(`login:ip:${ip}`, 30, 60_000)
  if (!ipLimit.ok) return ipLimit
  const account = createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
  // Scope the account cooldown to the source IP: an attacker cannot lock out
  // the same account from a different network. Never reset the IP budget on success.
  return rateLimit(`login:account:${ip}:${account}`, 5, 60_000)
}

/** Test-only reset. */
export function resetRateLimits(): void {
  buckets.clear()
  nextSweepAt = 0
}
