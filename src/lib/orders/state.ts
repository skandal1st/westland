import type { OrderStatus } from '@prisma/client'

/** Business decisions are separate from delivery acknowledgements. */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['CONFIRMED', 'REVIEW_REQUIRED', 'REJECTED', 'CANCELLED'],
  REVIEW_REQUIRED: ['CONFIRMED', 'REJECTED', 'CANCELLED'],
  REJECTED: [],
  CONFIRMED: ['PROCESSING', 'REVIEW_REQUIRED', 'REJECTED', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  PLACED: ['CONFIRMED', 'REVIEW_REQUIRED', 'REJECTED', 'CANCELLED'],
}

export const EXPORTABLE_ORDER_STATUSES: OrderStatus[] = ['SUBMITTED', 'PLACED', 'CONFIRMED', 'PROCESSING']

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

/** Adapter-normalized semantic statuses, NOT a mapping of unverified native UT 11 codes.
 * CONFIRMED means the original requested composition and total were approved.
 * A transport ACCEPTED/success cannot confirm stock or authorize an invoice.
 */
export function mapProviderStatus(providerStatus: string): OrderStatus | null {
  const map: Record<string, OrderStatus> = {
    CONFIRMED: 'CONFIRMED',
    REJECTED: 'REJECTED',
    DECLINED: 'REJECTED',
    REVIEW_REQUIRED: 'REVIEW_REQUIRED',
    PARTIALLY_CONFIRMED: 'REVIEW_REQUIRED',
    PROCESSING: 'PROCESSING',
    SHIPPED: 'PROCESSING',
    COMPLETED: 'COMPLETED',
    DONE: 'COMPLETED',
    CANCELLED: 'CANCELLED',
    CANCELED: 'CANCELLED',
  }
  return map[providerStatus.toUpperCase()] ?? null
}
