'use client'

import { useRef, useState } from 'react'

const ERRORS: Record<string, string> = {
  VERSION_CONFLICT: 'Счёт уже изменён другим запросом. Обновите список и проверьте действующую версию.',
  NUMBER_CONFLICT: 'Номер счёта уже занят. Обратитесь к администратору: действующий счёт сохранён.',
  REQUEST_CONFLICT: 'Этот запрос относится к другой версии счёта. Обновите список.',
  INVALID_STATE: 'Счёт недоступен в текущем состоянии заказа. Обновите список.',
  NO_BANK_REQUISITES: 'Счёт не выпущен: в сохранённых условиях заказа отсутствуют корректные банковские реквизиты. Требуется согласованное переоформление заказа.',
  NO_SELLER_REQUISITES: 'Счёт не выпущен: в сохранённых условиях заказа не заполнен продавец.',
  SNAPSHOT_REQUIRED: 'Для этого заказа не сохранены согласованные условия. Обратитесь к администратору.',
  INVALID_INPUT: 'Не удалось подготовить запрос. Обновите страницу.',
  license_absent: 'Выпуск счёта недоступен: лицензия не найдена.',
  license_invalid: 'Выпуск счёта недоступен: требуется проверка лицензии.',
  forbidden: 'Недостаточно прав для выпуска счёта.',
  unauthorized: 'Войдите в систему повторно.',
  ORDER_NOT_FOUND: 'Заказ не найден.',
}
type Attempt = { requestKey: string; expectedVersion: number }

export function InvoiceIssueButton({ orderId, invoice, onChanged }: {
  orderId: string; invoice: { number: string; version: number } | null; onChanged: () => Promise<void>
}) {
  const [confirm, setConfirm] = useState(false)
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [busy, setBusy] = useState(false)
  const inProgress = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [finished, setFinished] = useState(false)

  async function refresh() {
    try { await onChanged() }
    catch { setError('Не удалось обновить список. Повторите обновление перед новым выпуском.') }
  }
  async function issue() {
    if (inProgress.current) return
    inProgress.current = true; setBusy(true); setError(null)
    try {
      const request = attempt ?? { requestKey: crypto.randomUUID(), expectedVersion: invoice?.version ?? 0 }
      setAttempt(request)
      const response = await fetch('/api/staff/orders/' + orderId + '/invoice', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      })
      if (response.status >= 500) throw Error('uncertain_response')
      const result = await response.json()
      if (!response.ok) {
        setAttempt(null); setConfirm(false)
        setError(ERRORS[result.error] ?? 'Счёт не выпущен. Проверьте состояние заказа и повторите запрос.')
        return
      }
      setAttempt(null); setConfirm(false); setFinished(true)
      if (result.status === 'VOID') setError('Этот запрос уже выполнен, но счёт заменён новой версией. Обновите список.')
      await refresh()
    } catch {
      setError('Ответ не получен. Повторите тот же запрос: второй счёт не будет создан.')
    } finally { inProgress.current = false; setBusy(false) }
  }

  return <span className="invoice-issue-action">
    {error ? <span role="alert">{error}</span> : null}
    {finished ? <button type="button" onClick={refresh}>Обновить список счетов</button>
      : attempt ? <button type="button" disabled={busy} onClick={issue}>{busy ? 'Выпуск…' : 'Повторить запрос счёта'}</button>
      : confirm ? <span role="group" aria-label="Подтверждение перевыпуска счёта" className="invoice-reissue-confirm">
        <span>Счёт {invoice?.number} будет заменён новой версией. Суммы и реквизиты останутся из согласованного заказа.</span>
        <button type="button" disabled={busy} onClick={issue}>Выпустить новую версию</button>
        <button type="button" disabled={busy} onClick={() => setConfirm(false)}>Оставить текущий счёт</button>
      </span>
      : <button type="button" disabled={busy} onClick={() => invoice ? setConfirm(true) : issue()}>{invoice ? 'Перевыпустить счёт' : 'Выставить счёт'}</button>}
    {error && !attempt && !finished ? <button type="button" onClick={refresh}>Обновить список счетов</button> : null}
  </span>
}
