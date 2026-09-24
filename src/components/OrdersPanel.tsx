'use client'

import { orderStatusLabel, orderExportLabel, orderActionLabel } from '@/lib/status-labels'
import { formatMoney } from '@/lib/money-format'

import { InvoiceIssueButton } from './InvoiceIssueButton'
import { ManualOrderConfirmation } from './ManualOrderConfirmation'
import { Fragment, useEffect, useState } from 'react'
import { readArray, useRemoteResource } from '@/lib/use-remote-resource'
import { InvoiceDownloadLink } from './InvoiceDownloadLink'

type Order = {
  id: string
  number: string
  status: string
  total: string
  currency: string
  customer: string
  providerDecisionMessage: string | null
  cancellationRequestedAt: string | null
  canIssueInvoice: boolean
  canManuallyConfirm: boolean
  manualConfirmation: {documentNumber:string;documentDate:string;confirmedAt:string;revoked:boolean}|null
  export: { status: string; externalId: string | null; attempts: number; lastError: string | null } | null
  invoice: { number: string; version: number } | null
}

type OrderComposition = {
  id: string
  number: string
  total: string
  currency: string
  comment: string
  items: Array<{
    id: string
    sku: string
    sourceSku: string | null
    name: string
    packaging: string
    quantity: string
    unitPrice: string
    lineTotal: string
  }>
}

const NEXT: Record<string, string[]> = {
  SUBMITTED: ['CONFIRMED', 'CANCELLED'],
  REVIEW_REQUIRED: ['CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
}

const decodeOrders = (value: unknown) => readArray<Order>(value, 'orders')

const decodeComposition = (value: unknown): OrderComposition => {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) {
    throw new Error('Не удалось прочитать состав заказа.')
  }
  return value as OrderComposition
}

export function OrdersPanel() {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const resource = useRemoteResource('/api/staff/orders', decodeOrders)
  const orders = resource.data ?? []
  const load = resource.reload
  const [busyId, setBusyId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [compositions, setCompositions] = useState<Record<string, OrderComposition>>({})
  const [compositionLoading, setCompositionLoading] = useState<Record<string, boolean>>({})
  const [compositionErrors, setCompositionErrors] = useState<Record<string, string | null>>({})

  const hasQueuedExports = orders.some(order => ['PENDING', 'PROCESSING', 'RETRYING', 'AWAITING_ACK'].includes(order.export?.status ?? ''))
  useEffect(() => {
    if (!hasQueuedExports) return
    let cancelled = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => { try { await load() } catch { if (!cancelled) setMessage('Не удалось обновить состояние передачи.') } finally { if (!cancelled) timer = setTimeout(poll, 5_000) } }
    timer = setTimeout(poll, 2_000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [hasQueuedExports, load])

  const act = async (id: string, url: string, body?: unknown) => {
    setBusyId(id)
    try {
      const response = await fetch(url, { method: 'POST', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
      const result = await response.json().catch(() => ({}))
      setMessage(response.status === 202 ? 'Передача принята в очередь.' : response.ok ? null : (result.error === 'NO_BANK_REQUISITES' ? 'Счёт не выпущен: в сохранённых условиях заказа отсутствуют или некорректны банковские реквизиты продавца (банк, БИК, расчётный и корреспондентский счета).' : 'Операция не выполнена. Обновите список и проверьте состояние заказа.'))
      await load()
    } catch { setMessage('Не удалось выполнить операцию или обновить список. Проверьте состояние заказа перед повтором.') } finally {
      setBusyId(null)
    }
  }

  const loadComposition = async (id: string) => {
    setCompositionLoading((current) => ({ ...current, [id]: true }))
    setCompositionErrors((current) => ({ ...current, [id]: null }))
    try {
      const response = await fetch(`/api/staff/orders/${encodeURIComponent(id)}`)
      const result = await response.json().catch(() => null)
      if (!response.ok) throw new Error('Не удалось загрузить состав заказа. Обновите список и повторите попытку.')
      const composition = decodeComposition(result)
      setCompositions((current) => ({ ...current, [id]: composition }))
    } catch (error) {
      setCompositionErrors((current) => ({ ...current, [id]: error instanceof Error ? error.message : 'Не удалось загрузить состав заказа.' }))
    } finally {
      setCompositionLoading((current) => ({ ...current, [id]: false }))
    }
  }

  const toggleComposition = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }
    setExpandedId(id)
    if (!compositions[id] && !compositionLoading[id]) void loadComposition(id)
  }

  return (
    <div className="staff-table orders-table">
      <button type="button" disabled={resource.loading} onClick={load}>Обновить заказы</button>
      {resource.loading ? <p role="status">Загрузка заказов…</p> : null}
      {resource.error ? <div className="load-error" role="alert"><span>{resource.error}</span><button type="button" onClick={load}>Повторить загрузку заказов</button></div> : null}
      {!resource.loading && !resource.error && orders.length === 0 ? <p>Пока нет заказов. Они появятся после оформления покупателями.</p> : null}
      {message ? <p role="status">{message}</p> : null}
      <div className="table-head"><span>Заказ</span><span>Покупатель</span><span>Сумма</span><span>Статус</span><span>Передача в 1С</span><span>Счёт</span><span>Действия</span></div>
      {orders.map((order) => (
        <Fragment key={order.id}><div className="table-row">
          <span data-label="Заказ" className="order-identity"><strong>{order.number}</strong>{order.manualConfirmation ? <small>{order.manualConfirmation.revoked ? 'Проверка отозвана' : 'Проверено менеджером'} · 1С {order.manualConfirmation.documentNumber}</small> : null}</span>
          <span data-label="Покупатель">{order.customer}</span>
          <span data-label="Сумма">{formatMoney(order.total)} {order.currency === 'RUB' ? '₽' : order.currency}</span>
          <span data-label="Статус" className="status"><b>{orderStatusLabel(order.status)}</b>{order.providerDecisionMessage && ['REJECTED', 'REVIEW_REQUIRED'].includes(order.status) ? <small>{order.providerDecisionMessage}</small> : null}{order.cancellationRequestedAt && !['CANCELLED', 'REJECTED', 'COMPLETED'].includes(order.status) ? <small>Покупатель просит отмену</small> : null}</span>
          <span data-label="Передача в 1С" className="status">
            {order.export ? <><b className={'export-' + order.export.status.toLowerCase()}>{orderExportLabel(order.export.status)}</b>{order.export.lastError ? <small style={{ overflowWrap: 'anywhere' }}>{order.export.lastError}</small> : null}</> : '—'}
          </span>
          <span data-label="Счёт" className="status">
            {order.invoice ? <><InvoiceDownloadLink orderId={order.id} label={order.invoice.number} />{order.invoice.version > 1 ? <small>Версия {order.invoice.version}</small> : null}</> : '—'}
          </span>
          <span data-label="Действия" className="moderation-actions">
            <button className="order-composition-toggle" type="button" aria-expanded={expandedId === order.id} aria-controls={`order-composition-${order.id}`} onClick={() => toggleComposition(order.id)}>{expandedId === order.id ? 'Скрыть состав' : 'Состав заказа'}</button>
            {(NEXT[order.status] ?? []).filter(to => !(to === 'CONFIRMED' && ['DELIVERED','AWAITING_ACK'].includes(order.export?.status ?? ''))).map((to) => <button key={to} type="button" disabled={busyId === order.id} onClick={() => act(order.id, `/api/staff/orders/${order.id}/status`, { to, expectedStatus: order.status })}>{orderActionLabel(to)}</button>)}
            {!['CANCELLED', 'REJECTED', 'REVIEW_REQUIRED'].includes(order.status) && order.export && ['FAILED', 'RETRYING'].includes(order.export.status) ? <button type="button" disabled={busyId === order.id} onClick={() => act(order.id, `/api/staff/orders/${order.id}/export/retry`)}>Повторить передачу</button> : null}
            {order.export?.externalId ? <button type="button" disabled={busyId === order.id} onClick={() => act(order.id, `/api/staff/orders/${order.id}/reconcile`)}>Сверить статус с 1С</button> : null}
            {order.canManuallyConfirm ? <button type="button" disabled={busyId === order.id} onClick={() => setConfirmId(order.id)}>Проверить в 1С</button> : null}
            {order.canIssueInvoice ? <InvoiceIssueButton key={order.invoice?.version ?? 0} orderId={order.id} invoice={order.invoice} onChanged={load} /> : null}
          </span>
        </div>
        {expandedId === order.id ? <section className="order-composition-panel" id={`order-composition-${order.id}`} aria-labelledby={`order-composition-title-${order.id}`}>
          <div className="order-composition-summary">
            <div><h3 id={`order-composition-title-${order.id}`}>Состав заказа {order.number}</h3>{compositions[order.id] ? <span>Позиций: {compositions[order.id].items.length}</span> : null}</div>
            {compositions[order.id] ? <strong>{formatMoney(compositions[order.id].total)} {compositions[order.id].currency === 'RUB' ? '₽' : compositions[order.id].currency}</strong> : null}
          </div>
          {compositionLoading[order.id] ? <p role="status">Загрузка состава заказа…</p> : null}
          {compositionErrors[order.id] ? <div className="load-error" role="alert"><span>{compositionErrors[order.id]}</span><button type="button" onClick={() => void loadComposition(order.id)}>Повторить</button></div> : null}
          {compositions[order.id] ? <>
            {compositions[order.id].items.length ? <ul className="order-composition-lines">{compositions[order.id].items.map((item) => <li key={item.id}>
              <span><strong>{item.name}</strong><small>{item.sourceSku ?? item.sku}{item.packaging ? ` · ${item.packaging}` : ''}</small></span>
              <span><small>Количество</small>{item.quantity.replace('.', ',')}</span>
              <span><small>Цена</small>{formatMoney(item.unitPrice)} {compositions[order.id].currency === 'RUB' ? '₽' : compositions[order.id].currency}</span>
              <strong>{formatMoney(item.lineTotal)} {compositions[order.id].currency === 'RUB' ? '₽' : compositions[order.id].currency}</strong>
            </li>)}</ul> : <p>В заказе нет позиций.</p>}
            {compositions[order.id].comment ? <p className="order-composition-comment"><strong>Комментарий покупателя:</strong> {compositions[order.id].comment}</p> : null}
          </> : null}
        </section> : null}
        {confirmId === order.id ? <ManualOrderConfirmation orderId={order.id} onDone={load} onClose={() => setConfirmId(null)} /> : null}
        </Fragment>
      ))}
    </div>
  )
}
