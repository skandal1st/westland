'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { formatMoney } from '@/lib/money-format'
import { useRemoteResource } from '@/lib/use-remote-resource'
import { BuyerOrderSchema } from '@/lib/orders/buyer-response'
import { readCheckoutAttempt } from '@/lib/cart/checkout-recovery'
import { OrderDraftActions } from './OrderDraftActions'
import { InvoiceDownloadLink } from './InvoiceDownloadLink'
import { OrderTransferStatus } from './OrderTransferStatus'
import { orderStatusLabel } from '@/lib/status-labels'

const decodeOrder = (value: unknown) => {
  const result = BuyerOrderSchema.safeParse(value)
  if (!result.success) throw new Error('Не удалось прочитать заявку. Повторите загрузку.')
  return result.data
}
export function OrderDetailsClient({ orderId, storageKey }: { orderId: string; storageKey: string }) {
  const { data: order, loading, error, reload } = useRemoteResource('/api/orders/' + encodeURIComponent(orderId), decodeOrder)
  useEffect(() => {
    if (!order) return
    try { if (readCheckoutAttempt(sessionStorage.getItem(storageKey))?.orderId === order.id) sessionStorage.removeItem(storageKey) } catch { /* Storage may be disabled; the order remains in history. */ }
  }, [order, storageKey])
  return <main className="account-page order-details">
    <h1>{order ? 'Заявка ' + order.number : 'Ваша заявка'}</h1>
    {loading ? <p role="status">Загрузка заявки…</p> : null}
    {error ? <div className="load-error" role="alert"><span>{error}</span><button type="button" onClick={reload}>Повторить загрузку заявки</button></div> : null}
    {order ? <>
      <p>{orderStatusLabel(order.status)}</p>
      <ul className="order-lines">{order.items.map((line, index) => <li key={index}><span>{line.name} · {line.sourceSku ?? line.sku} × {line.quantity}</span><strong>{formatMoney(line.lineTotal)} {order.currency}</strong></li>)}</ul>
      <p><strong>Итого: {formatMoney(order.total)} {order.currency}</strong></p>
      {order.comment ? <p className="order-comment">Комментарий: {order.comment}</p> : null}
      <OrderTransferStatus status={order.status} exportState={order.export} />
      <OrderDraftActions orderId={order.id} initialStatus={order.status} transferStarted={order.transferStarted} cancellationRequestedAt={order.cancellationRequestedAt} erpConfirmed={order.erpConfirmed} manuallyConfirmed={order.manuallyConfirmed} providerDecisionMessage={order.providerDecisionMessage} onChange={reload} />
      {order.invoice ? <InvoiceDownloadLink orderId={order.id} label={['CANCELLED', 'REJECTED', 'REVIEW_REQUIRED'].includes(order.status) ? 'История счёта (PDF)' : 'Счёт (PDF)'} /> : <p>Счёт появится после подтверждения заказа и выпуска менеджером.</p>}
      <button type="button" className="button button-secondary" disabled={loading} onClick={reload}>Обновить состояние заявки</button>
    </> : null}
    <nav className="order-links"><Link href="/account/orders">Мои заявки</Link><Link href="/catalog">Вернуться в каталог</Link></nav>
  </main>
}
