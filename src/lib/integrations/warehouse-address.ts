import { z } from 'zod'

/** Explicit warehouse data; a buyer delivery address must never be substituted. */
export const WarehouseAddressSchema = z.object({
  city: z.string().trim().min(1).max(100),
  address: z.string().trim().max(150).optional(),
}).strict()
