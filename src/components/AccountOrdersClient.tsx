'use client'

import { orderStatusLabel } from '@/lib/status-labels'
import { formatMoney } from '@/lib/money-format'

import { OrderDraftActions } from '@/components/OrderDraftActions'
import { Package } from 'lucide-react'
import Link from 'next/link'
import { InvoiceDownloadLink } from './InvoiceDownloadLink'
import { OrderTransferStatus } from './OrderTransferStatus'
import { readArray, useRemoteResource } from '@/lib/use-remote-resource'

type Order = {
  id: string
  number: string
  status: string
  total: string
  currency: string
  createdAt: string
  export: string | null
  cancellationRequestedAt: string | null
  transferStarted: boolean
  erpConfirmed: boolean
  manuallyConfirmed: boolean
  providerDecisionMessage: string | null
  hasInvoice: boolean
}


const decodeOrders = (value: unknown) => readArray<Order>(value, 'orders')

export function AccountOrdersClient() {
  const { data, loading, error, reload: load } = useRemoteResource('/api/orders', decodeOrders)
  const orders = data ?? []

  return (
    <main className="account-page">
      <header><div><h1>Мои заказы</h1><p>История заказов и счета на оплату.</p></div></header>
      {loading ? <p role="status">Загрузка заказов…</p> : null}
      {error ? <div className="load-error" role="alert"><span>{error}</span><button type="button" onClick={load}>Повторить загрузку заказов</button></div> : null}
      {!data ? null : !loading && !error && orders.length === 0 ? (
        <div className="locations-empty"><Package /><h2>Заказов пока нет</h2><p>Создайте заявку из каталога. Счёт доступен после подтверждения в 1С.</p></div>
      ) : (
        <div className="locations-list">
          {orders.map((order) => (
            <div className="location-card" key={order.id}>
              <Package />
              <span>
                <strong><Link href={'/checkout?order=' + encodeURIComponent(order.id)}>Заказ {order.number}</Link></strong>
                <small>{new Date(order.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })} · {order.manuallyConfirmed && order.status === 'CONFIRMED' ? 'Подтверждён менеджером' : order.status === 'CONFIRMED' && !order.erpConfirmed ? 'Ожидает подтверждения 1С' : orderStatusLabel(order.status)}</small>
                <small>{formatMoney(order.total)} {order.currency}</small>
              </span>
              {order.hasInvoice ? (
                <InvoiceDownloadLink orderId={order.id} label={(['REJECTED', 'REVIEW_REQUIRED', 'CANCELLED'].includes(order.status)) ? 'История счёта (PDF)' : 'Счёт (PDF)'} />
              ) : (
                <b>{order.status === 'CANCELLED' ? 'Отменён' : order.status === 'REJECTED' ? 'Заявка отклонена' : order.manuallyConfirmed ? 'Менеджер готовит счёт' : 'Счёт после подтверждения 1С'}</b>
              )}
              <OrderTransferStatus status={order.status} exportState={order.export} />
              {order.status === 'DRAFT' ? <Link className="button button-secondary" href={'/checkout?order=' + encodeURIComponent(order.id)}>Продолжить заявку</Link> : null}
              <OrderDraftActions orderId={order.id} initialStatus={order.status} erpConfirmed={order.erpConfirmed} manuallyConfirmed={order.manuallyConfirmed} providerDecisionMessage={order.providerDecisionMessage} cancellationRequestedAt={order.cancellationRequestedAt} transferStarted={order.transferStarted} onChange={load} />
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
