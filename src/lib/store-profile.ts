import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { BROWSER_STORAGE_NAMESPACE } from '@/lib/app-config'

/**
 * Typed, validated deployment profile (see docs/PLATFORM_FOUNDATION.md).
 *
 * Server-only — reads the filesystem. Client components must import the
 * PublicStoreProfile *type* only and receive its value via props/context.
 *
 * The profile is the typed identity + capability + policy contract of a single
 * deployment. Secrets and mutable business data are NOT here (they live in env
 * / secret storage and the database). Client-specific values (name, theme,
 * policies) come from here, never from hardcoded literals in components.
 */
export const StoreProfileSchema = z.object({
  identity: z.object({
    code: z.string().min(1),
    name: z.string().min(1),
    legalName: z.string().optional(),
  }),
  modules: z.object({
    core: z.boolean().optional(),
    b2b: z.boolean(),
    content: z.boolean(),
    invoices: z.boolean(),
    promotions: z.boolean(),
  }),
  policies: z.object({
    catalogRequiresAuth: z.boolean(),
    registration: z.enum(['manual', 'auto']),
    requireAgeConfirmation: z.boolean(),
  }),
  integrations: z.object({
    primaryErp: z.enum(['one-c', 'moysklad', 'custom']),
  }),
  theme: z.object({
    id: z.string().min(1),
    defaultPalette: z.string().min(1),
  }),
  // Config-level placeholder until the FulfillmentChannel domain model is fixed
  // in M5. Deliberately NOT a bootstrap DB row (see plan §M1).
  defaultChannelCode: z.string().min(1),
})

export type StoreProfile = z.infer<typeof StoreProfileSchema>

/** Safe platform defaults used when no deployment profile file is present (dev). */
export const DEV_STORE_PROFILE: StoreProfile = {
  identity: { code: 'dev', name: 'AXIMA Commerce (dev)' },
  modules: { b2b: true, content: true, invoices: true, promotions: true },
  policies: { catalogRequiresAuth: true, registration: 'manual', requireAgeConfirmation: true },
  integrations: { primaryErp: 'custom' },
  theme: { id: 'default', defaultPalette: 'graphite' },
  defaultChannelCode: 'DEFAULT',
}

function mapErp(provider: unknown): StoreProfile['integrations']['primaryErp'] {
  if (provider === 'one-c' || provider === 'moysklad') return provider
  return 'custom'
}

/**
 * Map the deployment profile written by scripts/install.mjs (store/modules/
 * integration shape) into the runtime StoreProfile, deriving policy/theme
 * defaults and honouring an optional `runtime` override block. Keeping the
 * mapping here means install.mjs stays untouched and the app reads one file.
 */
export function deploymentProfileToRuntime(raw: unknown): StoreProfile {
  const dp = (raw ?? {}) as Record<string, any>
  const modules: string[] = Array.isArray(dp.modules) ? dp.modules : []
  const rt: Record<string, any> = dp.runtime ?? {}
  return StoreProfileSchema.parse({
    identity: {
      code: dp.store?.code,
      name: dp.store?.name,
      legalName: dp.store?.legalName,
    },
    modules: {
      core: modules.includes('commerce-core'),
      b2b: modules.includes('commerce-b2b'),
      content: modules.includes('content'),
      invoices: modules.includes('invoices'),
      promotions: modules.includes('promotions'),
    },
    policies: {
      catalogRequiresAuth: rt.catalogRequiresAuth ?? true,
      registration: rt.registration ?? 'manual',
      requireAgeConfirmation: rt.requireAgeConfirmation ?? true,
    },
    integrations: { primaryErp: mapErp(dp.integration?.provider) },
    theme: {
      id: rt.themeId ?? dp.store?.code ?? 'default',
      defaultPalette: rt.defaultPalette ?? 'graphite',
    },
    defaultChannelCode: rt.defaultChannelCode ?? 'DEFAULT',
  })
}

let cache: StoreProfile | null = null

export function loadStoreProfile(): StoreProfile {
  if (cache) return cache
  const file = process.env.STORE_PROFILE_PATH || path.join(process.cwd(), 'deployment', 'config', 'store-profile.json')
  if (!fs.existsSync(file)) {
    cache = DEV_STORE_PROFILE
    return cache
  }
  cache = deploymentProfileToRuntime(JSON.parse(fs.readFileSync(file, 'utf8')))
  return cache
}

export function resetStoreProfileCache(): void {
  cache = null
}

/** Serializable subset safe to hand to client components. */
export type PublicStoreProfile = {
  identity: { code: string; name: string }
  policies: StoreProfile['policies']
  theme: StoreProfile['theme']
  storageNamespace: string
}

export function toPublicProfile(profile: StoreProfile): PublicStoreProfile {
  return {
    identity: { code: profile.identity.code, name: profile.identity.name },
    policies: profile.policies,
    theme: profile.theme,
    storageNamespace: BROWSER_STORAGE_NAMESPACE,
  }
}
