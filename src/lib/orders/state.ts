import type { OrderStatus } from '@prisma/client'

/**
 * Business order lifecycle. This is intentionally independent of the export
 * (integration) lifecycle — provider outcomes never appear here.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  PLACED: ['CONFIRMED', 'CANCELLED'], // legacy value retained for compatibility
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

/** Map an opaque provider status onto the business lifecycle (reconciliation). */
export function mapProviderStatus(providerStatus: string): OrderStatus | null {
  const map: Record<string, OrderStatus> = {
    CONFIRMED: 'CONFIRMED',
    ACCEPTED: 'CONFIRMED',
    PROCESSING: 'PROCESSING',
    SHIPPED: 'PROCESSING',
    COMPLETED: 'COMPLETED',
    DONE: 'COMPLETED',
    CANCELLED: 'CANCELLED',
    CANCELED: 'CANCELLED',
  }
  return map[providerStatus.toUpperCase()] ?? null
}
