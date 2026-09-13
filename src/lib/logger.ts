/**
 * Minimal structured logger with secret redaction.
 *
 * Cross-cutting rule (see plan §3 Security): secrets must never reach logs.
 * Any field whose key looks sensitive, or whose value matches a known secret
 * shape, is replaced with `[redacted]` before serialization.
 */
type Level = 'debug' | 'info' | 'warn' | 'error'

const SENSITIVE_KEY = /(password|secret|token|apikey|api_key|authorization|cookie|activationkey|privatekey|databaseurl|database_url|connectionstring)/i

export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    // Redact obvious connection URLs with embedded credentials.
    if (/:\/\/[^/@\s]+:[^/@\s]+@/.test(value)) return '[redacted]'
    return value
  }
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value as object)) return '[circular]'
  seen.add(value as object)
  if (Array.isArray(value)) return value.map((item) => redact(item, seen))
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(val, seen)
  }
  return out
}

function emit(level: Level, message: string, context?: Record<string, unknown>) {
  const line = { level, message, time: new Date().toISOString(), ...(context ? { context: redact(context) } : {}) }
  const serialized = JSON.stringify(line)
  if (level === 'error') console.error(serialized)
  else if (level === 'warn') console.warn(serialized)
  else console.log(serialized)
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => emit('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => emit('error', message, context),
}
