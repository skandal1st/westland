/** Russian UI labels only. API/database codes remain unchanged. */
import type { OrderStatus, OrderExportStatus, ProductStatus } from '@prisma/client'

const ORDER_LABELS = {
  DRAFT: 'Черновик', SUBMITTED: 'Ожидает подтверждения 1С', PLACED: 'Размещён',
  CONFIRMED: 'Подтверждён', PROCESSING: 'В обработке', COMPLETED: 'Выполнен',
  CANCELLED: 'Отменён', REJECTED: 'Отклонён учётной системой', REVIEW_REQUIRED: 'Требует согласования',
} satisfies Record<OrderStatus, string>
const EXPORT_LABELS = {
  PENDING: 'В очереди на передачу', PROCESSING: 'Передаётся',
  AWAITING_ACK: 'Ожидает подтверждения получения', DELIVERED: 'Получен системой 1С',
  SUCCESS: 'Передача завершена', FAILED: 'Ошибка передачи', RETRYING: 'Ожидает повторной передачи',
} satisfies Record<OrderExportStatus, string>
const PRODUCT_LABELS = { DRAFT: 'Черновик', ACTIVE: 'Активен', ARCHIVED: 'В архиве' } satisfies Record<ProductStatus, string>
const ACTION_LABELS = {
  CONFIRMED: 'Подтвердить заказ', PROCESSING: 'Взять в обработку',
  COMPLETED: 'Завершить заказ', CANCELLED: 'Отменить заказ',
}
function label(labels: Record<string, string>, value: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : fallback
}
export const orderStatusLabel = (value: string) => label(ORDER_LABELS, value, 'Статус не определён')
export const orderExportLabel = (value: string) => label(EXPORT_LABELS, value, 'Состояние передачи не определено')
export const productStatusLabel = (value: string) => label(PRODUCT_LABELS, value, 'Статус не определён')
export const orderActionLabel = (value: string) => label(ACTION_LABELS, value, 'Изменить статус')
export const providerLabel = (value: string) => label({ ONE_C: '1С', MOYSKLAD: 'МойСклад', CUSTOM: 'Другое подключение' }, value, 'Другое подключение')
