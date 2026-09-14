'use client'

import { useCallback, useEffect, useState } from 'react'

type Order = {
  id: string
  number: string
  status: string
  total: number
  currency: string
  customer: string
  export: { status: string; externalId: string | null; attempts: number; lastError: string | null } | null
}

const NEXT: Record<string, string[]> = {
  SUBMITTED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
}

export function OrdersPanel() {
  const [orders, setOrders] = useState<Order[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/staff/orders')
    if (response.ok) setOrders((await response.json()).orders ?? [])
  }, [])
  useEffect(() => { load() }, [load])

  const act = async (id: string, url: string, body?: unknown) => {
    setBusyId(id)
    try {
      await fetch(url, { method: 'POST', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      await load()
    } finally {
      setBusyId(null)
    }
  }

  if (orders.length === 0) return <div className="staff-placeholder"><h2>Заказы</h2><p>Пока нет заказов. Они появятся после оформления покупателями.</p></div>

  return (
    <div className="staff-table orders-table">
      <div className="table-head"><span>Заказ</span><span>Покупатель</span><span>Сумма</span><span>Статус</span><span>Экспорт</span><span>Действия</span></div>
      {orders.map((order) => (
        <div className="table-row" key={order.id}>
          <span><strong>{order.number}</strong></span>
          <span>{order.customer}</span>
          <span>{order.total.toLocaleString('ru-RU')} {order.currency === 'RUB' ? '₽' : order.currency}</span>
          <span className="status"><b>{order.status}</b></span>
          <span className="status">
            {order.export ? <><b className={'export-' + order.export.status.toLowerCase()}>{order.export.status}</b>{order.export.lastError ? <small title={order.export.lastError}>ошибка</small> : null}</> : '—'}
          </span>
          <span className="moderation-actions">
            {(NEXT[order.status] ?? []).map((to) => <button key={to} type="button" disabled={busyId === order.id} onClick={() => act(order.id, `/api/staff/orders/${order.id}/status`, { to })}>{to}</button>)}
            {order.export && order.export.status !== 'SUCCESS' ? <button type="button" disabled={busyId === order.id} onClick={() => act(order.id, `/api/staff/orders/${order.id}/export/retry`)}>Retry экспорт</button> : null}
            {order.export?.externalId ? <button type="button" disabled={busyId === order.id} onClick={() => act(order.id, `/api/staff/orders/${order.id}/reconcile`)}>Reconcile</button> : null}
          </span>
        </div>
      ))}
    </div>
  )
}
