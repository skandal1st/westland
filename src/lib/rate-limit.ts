/**
 * Best-effort in-memory fixed-window rate limiter for auth endpoints.
 *
 * Per-process only — good enough to blunt credential/registration abuse on a
 * single-node deployment. A shared/edge limiter can be layered at the reverse
 * proxy later; this is the application-level floor required by the plan.
 */
type Bucket = { count: number; resetAt: number }
const buckets = new Map<string, Bucket>()

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfterMs: 0 }
  }
  if (bucket.count >= limit) {
    return { ok: false, retryAfterMs: bucket.resetAt - now }
  }
  bucket.count += 1
  return { ok: true, retryAfterMs: 0 }
}

export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return headers.get('x-real-ip') ?? 'unknown'
}

/** Test-only reset. */
export function resetRateLimits(): void {
  buckets.clear()
}
