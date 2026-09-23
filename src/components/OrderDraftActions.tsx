'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { DraftQuoteSchema, OrderActionSchema } from '@/lib/orders/buyer-response'
import type { DraftQuote } from '@/lib/orders/errors'

const MESSAGES: Record<string, string> = {
  INVALID_AMOUNT: 'Сумма или количество недопустимы. Обратитесь к менеджеру.',
  DRAFT_EXPIRED: 'Срок черновика истёк. Соберите новую заявку с актуальными условиями.',
  CHANNEL_UNAVAILABLE: 'Выбранный способ получения больше недоступен. Соберите новую заявку.',
  CHANNEL_CHANGED: 'Условия получения изменились. Соберите новую заявку.',
  ITEM_UNAVAILABLE: 'Одна из позиций больше недоступна. Соберите новую заявку.',
  NO_PRICE: 'Для одной из позиций нет действующей цены. Обратитесь к менеджеру.',
  MIXED_CURRENCY: 'В заявке обнаружены разные валюты. Обратитесь к менеджеру.',
  INVALID_DELIVERY: 'Точка доставки недоступна. Соберите новую заявку.',
  STATE_CHANGED: 'Статус заявки изменился. Обновите список.',
  INVALID_STATE: 'Действие недоступно в текущем статусе заявки.',
  NOT_FOUND: 'Заявка недоступна.',
  unauthorized: 'Войдите в аккаунт повторно.',
  forbidden: 'Действие недоступно. Обратитесь к менеджеру.',
}

export function OrderDraftActions({ orderId, initialStatus, cancellationRequestedAt, transferStarted = false, erpConfirmed = false, manuallyConfirmed = false, providerDecisionMessage, onChange }: {
  orderId: string; initialStatus: string; cancellationRequestedAt?: string | null; transferStarted?: boolean; erpConfirmed?: boolean; manuallyConfirmed?: boolean; providerDecisionMessage?: string | null; onChange?: () => void | Promise<void>
}) {
  const [status, setStatus] = useState(initialStatus)
  const [requested, setRequested] = useState(!!cancellationRequestedAt)
  const [quote, setQuote] = useState<DraftQuote | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inProgress = useRef(false)
  const [expired, setExpired] = useState(false)
  useEffect(() => { setStatus(initialStatus); setRequested(!!cancellationRequestedAt) }, [initialStatus, cancellationRequestedAt])

  const act = async (action: 'submit' | 'cancel', token?: string) => {
    if (inProgress.current) return
    inProgress.current = true
    setBusy(true); setError(null)
    try {
      const response = await fetch(`/api/orders/${orderId}/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(token ? { priceConfirmationToken: token } : {}),
      })
      if (response.status >= 500) throw new Error('uncertain_response')
      const data = await response.json()
      if (!response.ok) {
        if (data.error === 'PRICE_CHANGED' && data.quote) { setQuote(DraftQuoteSchema.parse(data.quote)); return }
        if (data.error === 'DRAFT_EXPIRED') setExpired(true)
        setQuote(null)
        setError(MESSAGES[data.error] ?? 'Не удалось выполнить действие. Попробуйте ещё раз.')
        return
      }
      const result = OrderActionSchema.parse(data)
      if (result.orderId !== orderId) throw new Error('wrong_order_response')
      setStatus(result.status); setRequested(!!result.requested || !!result.cancellationRequestedAt)
      setQuote(null)
      await onChange?.()
    } catch {
      setError('Не удалось получить ответ. Повторите действие: заявка не будет отправлена повторно.')
    } finally { inProgress.current = false; setBusy(false) }
  }

  return <div className="order-draft-actions">
    {error ? <p role="alert" className="auth-error">{error}</p> : null}
    {status === 'DRAFT' ? <>
      <p>Черновик действует 24 часа с момента создания. При отправке проверим цены. Заявка не резервирует товар; наличие подтверждает 1С.</p>
      {quote ? <section className="order-price-quote" aria-label="Изменение цен">
        <h3>Цены изменились</h3>
        <ul>{quote.lines.map(line => <li key={line.id}>
          <strong>{line.name} × {line.quantity}</strong>
          <span>{line.previousUnitPrice} {quote.previousCurrency} → {line.unitPrice} {quote.currency} за единицу</span>
        </li>)}</ul>
        <p>Итого: {quote.previousTotal} {quote.previousCurrency} → <strong>{quote.total} {quote.currency}</strong></p>
        <button className="button button-primary" disabled={busy || expired} onClick={() => act('submit', quote.token)}>Подтвердить новые цены и отправить</button>
      </section> : !expired ? <button className="button button-primary" disabled={busy} onClick={() => act('submit')}>{busy ? 'Отправка…' : 'Отправить заявку'}</button> : <Link href="/catalog">Перейти в каталог</Link>}
    </> : status === 'SUBMITTED' ? <p role="status">Заявка принята. Ожидаем подтверждения наличия, состава и суммы в 1С. Счёт будет доступен после подтверждения.</p>
      : status === 'REJECTED' ? <p role="status">Учётная система отклонила заявку. Товар не зарезервирован; новый счёт не выпускается.</p>
      : status === 'REVIEW_REQUIRED' ? <p role="status">Учётная система подтвердила заявку не полностью или предложила изменения. Требуется согласование с менеджером. Состав и сумма заявки пока не изменены; новый счёт не выпускается.</p>
      : status === 'CONFIRMED' ? <p role="status">{manuallyConfirmed ? 'Менеджер сверил и подтвердил заказ в 1С.' : erpConfirmed ? 'Заявка подтверждена учётной системой.' : 'Статус обновлён менеджером. Подтверждение наличия, состава и суммы в 1С ещё не получено.'}</p>
      : status === 'CANCELLED' ? <p role="status">Заявка отменена.</p> : null}
    {providerDecisionMessage && ['REJECTED', 'REVIEW_REQUIRED'].includes(status) ? <p className="provider-decision-message">Сообщение учётной системы: {providerDecisionMessage}</p> : null}
    {requested && !['CANCELLED', 'REJECTED', 'COMPLETED'].includes(status) ? <p role="status">Запрос на отмену передан менеджеру. Заявка пока не отменена.</p>
      : !['CANCELLED', 'REJECTED', 'COMPLETED'].includes(status) ? <button className="button button-secondary" disabled={busy} onClick={() => act('cancel')}>{transferStarted ? 'Запросить отмену у менеджера' : 'Отменить заявку'}</button> : null}
  </div>
}
