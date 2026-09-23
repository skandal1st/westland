'use client'

import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

type CatalogFileStats = { file: string; bytes: number; mtime: string; products: number; groups: number; offers: number; prices: number; stock: number }
type ExchangeEvent = { at: string; type: string; detail?: string }
type Status = {
  updatedAt?: string
  lastCheckAuthAt?: string
  lastInitAt?: string
  lastImportAt?: string
  lastOrderQueryAt?: string
  session?: { startedAt: string; files: { name: string; bytes: number; at: string }[] }
  catalog?: CatalogFileStats[]
  events?: ExchangeEvent[]
}

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString('ru-RU') : '—')
const size = (b: number) => (b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' МБ' : Math.max(1, Math.round(b / 1024)) + ' КБ')

export function OnecExchangeStatus() {
  const [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/staff/integrations/onec/status')
      if (response.ok) setStatus(await response.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, 15000) // live-ish so 1C runs show up without a reload
    return () => clearInterval(timer)
  }, [load])

  const catalog = status?.catalog ?? []
  const products = catalog.reduce((sum, c) => sum + c.products, 0)
  const hasPrices = catalog.some((c) => c.prices > 0)
  const events = (status?.events ?? []).slice().reverse()

  return (
    <section className="onec-status">
      <div className="onec-status-head">
        <div><h3>Обмен с 1С</h3><small>Обновлено: {fmt(status?.updatedAt)}</small></div>
        <button className="button button-secondary" type="button" onClick={load} disabled={loading}><RefreshCw /> Обновить</button>
      </div>

      <div className="onec-status-grid">
        <div><span>Последняя авторизация</span><strong>{fmt(status?.lastCheckAuthAt)}</strong></div>
        <div><span>Начало выгрузки</span><strong>{fmt(status?.lastInitAt)}</strong></div>
        <div><span>Импорт каталога</span><strong>{fmt(status?.lastImportAt)}</strong></div>
        <div><span>Запрос заказов</span><strong>{fmt(status?.lastOrderQueryAt)}</strong></div>
      </div>

      {catalog.length === 0 ? (
        <p className="onec-empty">Файлы обмена ещё не получены.</p>
      ) : (
        <table className="onec-table">
          <thead><tr><th>Файл</th><th>Размер</th><th>Товары</th><th>Группы</th><th>Цены (&gt;0)</th><th>Остатки (&gt;0)</th></tr></thead>
          <tbody>
            {catalog.map((c) => (
              <tr key={c.file}>
                <td>{c.file}</td>
                <td>{size(c.bytes)}</td>
                <td>{c.products.toLocaleString('ru-RU')}</td>
                <td>{c.groups.toLocaleString('ru-RU')}</td>
                <td className={c.prices > 0 ? 'ok' : 'no'}>{c.prices.toLocaleString('ru-RU')}</td>
                <td className={c.stock > 0 ? 'ok' : 'no'}>{c.stock.toLocaleString('ru-RU')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {products > 0 && !hasPrices ? (
        <p className="onec-warn">Каталог получен ({products.toLocaleString('ru-RU')} товаров), но <b>цены/остатки не пришли</b>. Проверьте в 1С типовое соглашение (флаг «Доступно для обмена с сайтом», пустой сегмент) и что у вида цены проставлены значения.</p>
      ) : null}

      {events.length > 0 ? (
        <details className="onec-events">
          <summary>Журнал шагов ({events.length})</summary>
          <ul>{events.map((e, i) => <li key={i}><span>{fmt(e.at)}</span> <b>{{ checkauth: 'Авторизация', init: 'Начало обмена', file: 'Приём файла', import: 'Обработка файла', query: 'Запрос заказов', success: 'Обмен завершён' }[e.type] ?? 'Событие обмена'}</b>{e.detail ? ` — ${e.detail}` : ''}</li>)}</ul>
        </details>
      ) : null}
    </section>
  )
}
