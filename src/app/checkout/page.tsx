'use client'

import Link from 'next/link'
import { CheckCircle2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { StorefrontHeader } from '@/components/StorefrontHeader'
import { useCart } from '@/lib/cart/cart-context'

type Location = { id: string; name: string; city: string; address: string }

const ERRORS: Record<string, string> = {
  EMPTY_CART: 'Корзина пуста.',
  NO_CHANNEL: 'Выберите канал получения в каталоге.',
  NO_CUSTOMER: 'К аккаунту не привязана компания.',
  INVALID_DELIVERY: 'Выберите корректную точку доставки.',
  NO_PRICE: 'Для части позиций нет цены по вашей группе.',
  INSUFFICIENT_STOCK: 'Недостаточно остатка по выбранному каналу.',
}

export default function CheckoutPage() {
  const { view, refresh } = useCart()
  const [locations, setLocations] = useState<Location[]>([])
  const [locationId, setLocationId] = useState('')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [order, setOrder] = useState<{ id: string; number: string; total: number; currency: string } | null>(null)
  const [submitState, setSubmitState] = useState<'idle' | 'busy' | 'done'>('idle')
  const [exportStatus, setExportStatus] = useState<string | null>(null)
  const idempotencyKey = useMemo(() => (typeof crypto !== 'undefined' ? crypto.randomUUID() : String(Date.now())), [])
  const currency = view.currency === 'RUB' ? '₽' : view.currency

  useEffect(() => {
    fetch('/api/account/locations').then((r) => (r.ok ? r.json() : { locations: [] })).then((data) => {
      setLocations(data.locations ?? [])
      setLocationId((current) => current || data.locations?.[0]?.id || '')
    })
  }, [])

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deliveryLocationId: locationId, comment, idempotencyKey }) })
      const data = await response.json().catch(() => ({}))
      if (response.ok) { setOrder({ id: data.orderId, number: data.number, total: data.total, currency: data.currency }); await refresh() }
      else setError(ERRORS[data.error] ?? 'Не удалось оформить заказ.')
    } finally {
      setBusy(false)
    }
  }

  const submitOrder = async () => {
    if (!order) return
    setSubmitState('busy')
    const response = await fetch(`/api/orders/${order.id}/submit`, { method: 'POST' })
    const data = await response.json().catch(() => ({}))
    setExportStatus(data.export?.status ?? (response.ok ? 'PENDING' : 'ошибка'))
    setSubmitState('done')
  }

  if (order) {
    return (
      <>
        <StorefrontHeader />
        <main className="checkout-success">
          <CheckCircle2 />
          <h1>Заказ {order.number} {submitState === 'done' ? 'оформлен' : 'создан (черновик)'}</h1>
          {submitState !== 'done' ? (
            <>
              <p>Заказ сохранён как черновик. Подтвердите отправку — заказ будет передан в учётную систему.</p>
              <button className="button button-primary" disabled={submitState === 'busy'} onClick={submitOrder}>{submitState === 'busy' ? 'Отправка…' : 'Оформить и отправить'}</button>
            </>
          ) : (
            <p>Заказ отправлен. Статус экспорта в учётную систему: <strong>{exportStatus}</strong>. PDF-счёт появится на следующем этапе (M8).</p>
          )}
          <Link href="/catalog">Вернуться в каталог</Link>
        </main>
      </>
    )
  }

  return (
    <>
      <StorefrontHeader />
      <main className="checkout-page">
        <section>
          <h1>Оформление заказа</h1>
          <label>Точка доставки
            <select value={locationId} onChange={(event) => setLocationId(event.target.value)} required>
              <option value="" disabled>Выберите точку</option>
              {locations.map((point) => <option key={point.id} value={point.id}>{point.name} · {point.city}, {point.address}</option>)}
            </select>
          </label>
          <Link className="manage-locations" href="/account/locations">Управлять точками доставки</Link>
          <label>Комментарий<textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Комментарий к заказу" /></label>
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
        </section>
        <aside>
          <h2>Ваш заказ</h2>
          {view.lines.map((line) => <div key={line.variantId}><span>{line.displayName} × {line.quantity}</span><b>{line.lineTotal != null ? `${line.lineTotal.toLocaleString('ru-RU')} ${currency}` : '—'}</b></div>)}
          <div className="checkout-total"><span>Итого</span><strong>{view.total.toLocaleString('ru-RU')} {currency}</strong></div>
          <button className="button button-primary" disabled={busy || view.lines.length === 0 || !locationId} onClick={submit}>{busy ? 'Оформление…' : 'Создать заказ'}</button>
          <small>{locations.length === 0 ? 'Добавьте точку доставки, чтобы оформить заказ.' : 'Черновик заказа будет создан для дальнейшей обработки.'}</small>
        </aside>
      </main>
    </>
  )
}
