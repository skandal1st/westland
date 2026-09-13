import { z } from 'zod'

/**
 * Typed, fail-fast environment loader.
 *
 * Server-only. Do NOT import from client components — it reads server secrets.
 * Missing/invalid required variables abort process start with a clear message
 * instead of failing lazily deep inside a request.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid connection URL' }),
  // Auth is introduced in M2; optional at M0 so the app boots without it.
  NEXTAUTH_URL: z.string().url().optional(),
  NEXTAUTH_SECRET: z.string().min(16).optional(),
})

export type Env = z.infer<typeof schema>

let cached: Env | null = null

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  if (cached) return cached
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${details}`)
  }
  cached = parsed.data
  return cached
}

/** Test-only: reset the memoized env so a new source can be validated. */
export function resetEnvCache(): void {
  cached = null
}
