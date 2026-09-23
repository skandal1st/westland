import { z } from 'zod'

export const OrderStatusSchema = z.enum(['DRAFT', 'SUBMITTED', 'PLACED', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'REJECTED', 'REVIEW_REQUIRED'])
export const OrderActionSchema = z.object({ orderId: z.string().min(1), status: OrderStatusSchema, requested: z.boolean().optional(), cancellationRequestedAt: z.string().nullable().optional() })
export const CheckoutResultSchema = OrderActionSchema.extend({ number: z.string().min(1), total: z.string(), currency: z.string().min(1) })
export const DraftQuoteSchema = z.object({
  token: z.string().uuid(), currency: z.string(), previousCurrency: z.string(), total: z.string(), previousTotal: z.string(),
  lines: z.array(z.object({ id: z.string(), name: z.string(), quantity: z.string(), previousUnitPrice: z.string(), unitPrice: z.string(), lineTotal: z.string() })),
})
export const BuyerOrderSchema = z.object({
  id: z.string(), number: z.string(), status: OrderStatusSchema, total: z.string(), currency: z.string(), comment: z.string(),
  cancellationRequestedAt: z.string().nullable(), providerDecisionMessage: z.string().nullable(),
  manuallyConfirmed: z.boolean(), erpConfirmed: z.boolean(), transferStarted: z.boolean(), export: z.string().nullable(),
  items: z.array(z.object({ sku: z.string(), sourceSku: z.string().nullable(), name: z.string(), quantity: z.number(), unitPrice: z.string(), lineTotal: z.string() })),
  invoice: z.object({ id: z.string(), number: z.string(), version: z.number() }).nullable(),
})
