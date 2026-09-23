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

const NEXT: Record<string, string[]> = {
  SUBMITTED: ['CONFIRMED', 'CANCELLED'],
  REVIEW_REQUIRED: ['CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
}

const decodeOrders = (value: unknown) => readArray<Order>(value, 'orders')

export function OrdersPanel() {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const resource = useRemoteResource('/api/staff/orders', decodeOrders)
  const orders = resource.data ?? []
  const load = resource.reload
  const [busyId, setBusyId] = useState<string | null>(null)

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
            {(NEXT[order.status] ?? []).filter(to => !(to === 'CONFIRMED' && ['DELIVERED','AWAITING_ACK'].includes(order.export?.status ?? ''))).map((to) => <button key={to} type="button" disabled={busyId === order.id} onClick={() => act(order.id, `/api/staff/orders/${order.id}/status`, { to, expectedStatus: order.status })}>{orderActionLabel(to)}</button>)}
            {!['CANCELLED', 'REJECTED', 'REVIEW_REQUIRED'].includes(order.status) && order.export && ['FAILED', 'RETRYING'].includes(order.export.status) ? <button type="button" disabled={busyId === order.id} onClick={() => act(order.id, `/api/staff/orders/${order.id}/export/retry`)}>Повторить передачу</button> : null}
            {order.export?.externalId ? <button type="button" disabled={busyId === order.id} onClick={() => act(order.id, `/api/staff/orders/${order.id}/reconcile`)}>Сверить статус с 1С</button> : null}
            {order.canManuallyConfirm ? <button type="button" disabled={busyId === order.id} onClick={() => setConfirmId(order.id)}>Проверить в 1С</button> : null}
            {order.canIssueInvoice ? <InvoiceIssueButton key={order.invoice?.version ?? 0} orderId={order.id} invoice={order.invoice} onChanged={load} /> : null}
          </span>
        </div>
        {confirmId === order.id ? <ManualOrderConfirmation orderId={order.id} onDone={load} onClose={() => setConfirmId(null)} /> : null}
        </Fragment>
      ))}
    </div>
  )
}
