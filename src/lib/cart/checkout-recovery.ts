import { z } from 'zod'

export const CheckoutAttemptSchema = z.object({
  version: z.literal(1),
  payload: z.object({
    deliveryLocationId: z.string().min(1),
    comment: z.string().max(1000),
    idempotencyKey: z.string().uuid(),
    cartId: z.string().min(1),
    cartVersion: z.number().int().min(0).max(2147483647),
  }).strict(),
  orderId: z.string().min(1).optional(),
}).strict()

export type CheckoutAttempt = z.infer<typeof CheckoutAttemptSchema>
export function checkoutRecoveryKey(storeId: string, userId: string) {
  return 'axima-checkout-v1:' + JSON.stringify([storeId, userId])
}
export function readCheckoutAttempt(raw: string | null): CheckoutAttempt | null {
  try {
    const result = CheckoutAttemptSchema.safeParse(JSON.parse(raw ?? 'null'))
    return result.success ? result.data : null
  } catch { return null }
}
