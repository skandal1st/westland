'use client'
import { CartGifts } from './CartGifts'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useCart } from '@/lib/cart/cart-context'
import { formatMoney } from '@/lib/money-format'
import { readArray, useRemoteResource } from '@/lib/use-remote-resource'
import { readCheckoutAttempt, type CheckoutAttempt } from '@/lib/cart/checkout-recovery'
import { CheckoutResultSchema } from '@/lib/orders/buyer-response'
import { OrderDetailsClient } from './OrderDetailsClient'

type Location = { id: string; name: string; city: string; address: string }
const decodeLocations = (value: unknown) => readArray<Location>(value, 'locations')
const ERRORS: Record<string, string> = {
  GIFT_SELECTION_REQUIRED: 'Выберите доступный промотовар или откажитесь от подарка в корзине.',
  MIXED_CURRENCY: 'В заявке разные валюты. Обратитесь к менеджеру.',
  INVALID_AMOUNT: 'Сумма или количество недопустимы. Обратитесь к менеджеру.',
  CART_CHANGED: 'Корзина изменилась. Проверьте обновлённый состав и повторите оформление.',
  IDEMPOTENCY_CONFLICT: 'Этот запрос относится к другим условиям. Проверьте историю заявок перед новым оформлением.',
  ITEM_UNAVAILABLE: 'Часть товаров больше недоступна. Обновите корзину.',
  EMPTY_CART: 'Корзина пуста. Если вы уже оформляли заявку, откройте историю.',
  NO_CHANNEL: 'Выберите канал получения в каталоге.',
  NO_CUSTOMER: 'К аккаунту не привязана компания. Обратитесь к менеджеру.',
  INVALID_DELIVERY: 'Выберите доступную точку доставки.',
  NO_PRICE: 'Для части позиций нет цены по вашей группе.',
  unauthorized: 'Войдите в аккаунт повторно.',
  license_absent: 'Оформление временно недоступно. Обратитесь к менеджеру.',
  license_invalid: 'Оформление временно недоступно. Обратитесь к менеджеру.',
}

export function CheckoutClient({ storageKey }: { storageKey: string }) {
  const router = useRouter()
  const { view, ready, loadError, updating, changeError, refresh } = useCart()
  const locations = useRemoteResource('/api/account/locations', decodeLocations)
  const [locationId, setLocationId] = useState('')
  const [comment, setComment] = useState('')
  const [attempt, setAttempt] = useState<CheckoutAttempt | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [storageError, setStorageError] = useState(false)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const inProgress = useRef(false)

  useEffect(() => {
    try {
      const saved = readCheckoutAttempt(sessionStorage.getItem(storageKey))
      const form = JSON.parse(sessionStorage.getItem(storageKey + ':form') ?? 'null')
      if (saved) {
        setAttempt(saved); setLocationId(saved.payload.deliveryLocationId); setComment(saved.payload.comment)
        if (saved.orderId) { setCreatedId(saved.orderId); router.replace('/checkout?order=' + encodeURIComponent(saved.orderId)) }
      } else if (form && typeof form.locationId === 'string' && typeof form.comment === 'string') {
        setLocationId(form.locationId); setComment(form.comment.slice(0, 1000))
      }
    } catch { setStorageError(true) }
    setHydrated(true)
  }, [storageKey, router])

  useEffect(() => {
    if (hydrated && !locationId && locations.data?.[0]) setLocationId(locations.data[0].id)
  }, [hydrated, locationId, locations.data])

  useEffect(() => {
    if (!hydrated) return
    try { sessionStorage.setItem(storageKey + ':form', JSON.stringify({ locationId, comment })) }
    catch { setStorageError(true) }
  }, [hydrated, storageKey, locationId, comment])

  const remember = (value: CheckoutAttempt | null) => {
    setAttempt(value)
    try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey) }
    catch { setStorageError(true) }
  }
  const submit = async () => {
    if (inProgress.current || !hydrated || (!attempt && (view.cartId === null || view.version === null))) return
    inProgress.current = true; setBusy(true); setError(null)
    const request: CheckoutAttempt = attempt ?? { version: 1, payload: {
      deliveryLocationId: locationId, comment, idempotencyKey: crypto.randomUUID(), cartId: view.cartId!, cartVersion: view.version!,
    } }
    remember(request)
    try {
      const response = await fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.payload) })
      if (response.status >= 500) throw new Error('uncertain_response')
      const data = await response.json()
      if (!response.ok) {
        remember(null)
        setError(ERRORS[data.error] ?? 'Не удалось оформить заявку. Проверьте данные и повторите запрос.')
        if (['CART_CHANGED', 'GIFT_SELECTION_REQUIRED'].includes(data.error)) await refresh()
        return
      }
      const result = CheckoutResultSchema.parse(data)
      remember({ ...request, orderId: result.orderId })
      try { sessionStorage.removeItem(storageKey + ':form') } catch { /* Already reported storage failure. */ }
      setCreatedId(result.orderId)
      router.replace('/checkout?order=' + encodeURIComponent(result.orderId))
      await refresh()
    } catch {
      setError('Ответ не получен. Повторите оформление: будет отправлен тот же запрос, без создания второй заявки.')
    } finally { inProgress.current = false; setBusy(false) }
  }

  if (createdId) return <OrderDetailsClient orderId={createdId} storageKey={storageKey} />
  const points = locations.data ?? []
  const canCreate = ready && !updating && !changeError && !loadError && !locations.loading && !locations.error && view.lines.length > 0 && view.version !== null && points.some(point => point.id === locationId)
  const currency = view.currency === 'RUB' ? '₽' : view.currency
  return <main className="checkout-page">
    <section>
      <h1>Оформление заявки</h1>
      {!hydrated ? <p role="status">Восстановление заявки…</p> : null}
      {attempt ? <div className="load-error" role="status"><span>Есть незавершённая попытка оформления. Повторите тот же запрос или проверьте историю заявок.</span><Link href="/account/orders">Мои заявки</Link></div> : null}
      {storageError ? <p role="status">Браузер не сохраняет черновик формы. После обновления страницы проверьте заявку в истории.</p> : null}
      {locations.loading ? <p role="status">Загрузка точек доставки…</p> : null}
      {locations.error ? <div className="load-error" role="alert"><span>{locations.error}</span><button type="button" onClick={locations.reload}>Повторить загрузку точек</button></div> : null}
      <label>Точка доставки<select disabled={busy || !!attempt || !hydrated || locations.loading || !!locations.error} value={locationId} onChange={event => setLocationId(event.target.value)} required>
        <option value="" disabled>Выберите точку</option>
        {attempt && !points.some(point => point.id === locationId) ? <option value={locationId}>Точка из сохранённого запроса</option> : null}
        {points.map(point => <option key={point.id} value={point.id}>{point.name} · {point.city}, {point.address}</option>)}
      </select></label>
      <Link className="manage-locations" href="/account/locations">Управлять точками доставки</Link>
      <label>Комментарий<textarea maxLength={1000} disabled={busy || !!attempt || !hydrated} value={comment} onChange={event => setComment(event.target.value)} placeholder="Комментарий к заказу" /></label>
      {error ? <p className="auth-error" role="alert">{error}</p> : null}
    </section>
    <aside>
      <CartGifts />
      <h2>{attempt ? 'Повтор сохранённого запроса' : 'Ваша заявка'}</h2>
      {loadError ? <div className="load-error" role="alert"><span>{loadError}</span><button type="button" onClick={refresh}>Повторить загрузку корзины</button></div> : !ready ? <p role="status">Загрузка корзины…</p> : null}
      {changeError ? <p role="alert">Не подтверждено изменение корзины. <Link href="/catalog">Вернитесь в каталог и повторите изменение.</Link></p> : null}
      {!attempt ? <>
        {view.lines.map(line => <div key={line.variantId}><span>{line.displayName} × {line.quantity}</span><b>{line.lineTotal != null ? formatMoney(line.lineTotal) + ' ' + currency : '—'}</b></div>)}
        <div className="checkout-total"><span>Итого</span><strong>{formatMoney(view.total)} {currency}</strong></div>
        {ready && !loadError && view.lines.length === 0 ? <p>Корзина пуста. <Link href="/account/orders">Открыть созданные заявки</Link></p> : null}
      </> : <p>Проверим результат предыдущего оформления. Изменения текущей корзины не войдут в этот запрос.</p>}
      <button className="button button-primary" disabled={busy || !hydrated || (!attempt && !canCreate)} onClick={submit}>{busy ? 'Оформление…' : attempt ? 'Повторить оформление' : 'Создать заявку'}</button>
      <small>{!locations.loading && !locations.error && points.length === 0 ? 'Добавьте точку доставки или обратитесь к менеджеру для её назначения.' : 'Заявка не резервирует товар. Наличие, состав и сумму подтвердит 1С.'}</small>
    </aside>
  </main>
}
