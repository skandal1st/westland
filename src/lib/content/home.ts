import { z } from 'zod'

export const HOME_COMPANY_BLOCK_KEY = 'home-company-cta'

export function safeHomeCtaHref(value: string) {
  if (value.startsWith('/') && !value.startsWith('//')) return value
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : null
  } catch { return null }
}

export const homeCompanyBlockSchema = z.object({
  title: z.string().trim().min(1).max(160),
  text: z.string().trim().min(1).max(1800),
  ctaLabel: z.string().trim().max(80),
  ctaHref: z.string().trim().max(500),
  isActive: z.boolean(),
}).refine(value => !value.ctaHref || safeHomeCtaHref(value.ctaHref) !== null, { path: ['ctaHref'], message: 'Use a relative path or HTTPS URL' })

export type HomeCompanyBlock = z.infer<typeof homeCompanyBlockSchema>

export function parseHomeCompanyBlock(title: string | null, body: unknown): HomeCompanyBlock | null {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const parsed = homeCompanyBlockSchema.safeParse({ title, text: record.text, ctaLabel: record.ctaLabel ?? '', ctaHref: record.ctaHref ?? '', isActive: true })
  return parsed.success ? parsed.data : null
}
