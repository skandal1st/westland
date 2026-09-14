'use client'

import { FileText, Package } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

type Order = {
  id: string
  number: string
  status: string
  total: number
  currency: string
  createdAt: string
  export: string | null
  hasInvoice: boolean
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Черновик',
  SUBMITTED: 'Отправлен',
  PLACED: 'Размещён',
  CONFIRMED: 'Подтверждён',
  PROCESSING: 'В обработке',
  COMPLETED: 'Выполнен',
  CANCELLED: 'Отменён',
}

export function AccountOrdersClient() {
  const [orders, setOrders] = useState<Order[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const response = await fetch('/api/orders')
    if (response.ok) setOrders((await response.json()).orders ?? [])
    setLoading(false)
  }, [])
  useEffect(() => { load() }, [load])

  return (
    <main className="account-page">
      <header><div><h1>Мои заказы</h1><p>История заказов и счета на оплату.</p></div></header>
      {loading ? null : orders.length === 0 ? (
        <div className="locations-empty"><Package /><h2>Заказов пока нет</h2><p>Оформите первый заказ из каталога — он появится здесь вместе со счётом.</p></div>
      ) : (
        <div className="locations-list">
          {orders.map((order) => (
            <div className="location-card" key={order.id}>
              <Package />
              <span>
                <strong>Заказ {order.number}</strong>
                <small>{new Date(order.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })} · {STATUS_LABEL[order.status] ?? order.status}</small>
                <small>{order.total.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} {order.currency}</small>
              </span>
              {order.hasInvoice ? (
                <a className="button button-secondary" href={`/api/orders/${order.id}/invoice/pdf`} target="_blank" rel="noreferrer"><FileText /> Счёт (PDF)</a>
              ) : (
                <b>Счёт готовится</b>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
