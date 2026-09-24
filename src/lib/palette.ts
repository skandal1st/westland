import { z } from 'zod'

export const PaletteSchema = z.enum(['violet', 'blue', 'graphite', 'burgundy'])
export type PaletteId = z.infer<typeof PaletteSchema>
export const DEFAULT_PALETTE: PaletteId = 'graphite'

export function resolvePalette(value: unknown, fallback: PaletteId = DEFAULT_PALETTE): PaletteId {
  const parsed = PaletteSchema.safeParse(value)
  return parsed.success ? parsed.data : fallback
}
