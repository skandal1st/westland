'use client'

import { useCallback, useEffect, useState } from 'react'

type Warehouse = { id: string; total: number; positions: number; mappedName: string | null }
type Location = { id: string; code: string; name: string }

export function OnecWarehousesPanel() {
  const [rows, setRows] = useState<Warehouse[]>([])
  const [locations, setLocations] = useState<Location[]>([])
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/staff/integrations/onec/warehouses')
    if (!response.ok) return
    const data = await response.json()
    setRows(data.warehouses ?? [])
    setLocations(data.locations ?? [])
  }, [])
  useEffect(() => { load() }, [load])

  const map = async (warehouseId: string) => {
    const locationId = choice[warehouseId]
    if (!locationId) { setMessage('Выберите наш склад для привязки.'); return }
    setMessage(null)
    const response = await fetch('/api/staff/integrations/onec/warehouses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ warehouseId, locationId }),
    })
    if (response.ok) await load()
    else setMessage(response.status === 403 ? 'Привязка доступна только роли ADMIN.' : 'Не удалось привязать склад.')
  }

  if (rows.length === 0) return null

  return (
    <section className="onec-status">
      <div className="onec-status-head">
        <div><h3>Склады 1С (из offers)</h3><small>Привяжите склад 1С (GUID) к нашему складу — остатки лягут в него. Затем свяжите склад с каналом оплаты (нал/безнал) в разделе «Склады».</small></div>
      </div>
      {message ? <p className="settings-message" role="status">{message}</p> : null}
      {locations.length === 0 ? <p className="onec-empty">Сначала создайте склады в разделе «Склады», затем вернитесь и привяжите их к 1С.</p> : null}
      <table className="onec-table">
        <thead><tr><th>Склад 1С (GUID)</th><th>Остаток</th><th>Позиций</th><th>Наш склад</th></tr></thead>
        <tbody>
          {rows.map((w) => (
            <tr key={w.id}>
              <td><code className="onec-guid">{w.id}</code></td>
              <td>{w.total.toLocaleString('ru-RU')}</td>
              <td>{w.positions.toLocaleString('ru-RU')}</td>
              <td>
                {w.mappedName ? (
                  <b style={{ color: 'var(--success)' }}>{w.mappedName}</b>
                ) : (
                  <span className="onec-map">
                    <select value={choice[w.id] || ''} onChange={(e) => setChoice((p) => ({ ...p, [w.id]: e.target.value }))} aria-label="Наш склад">
                      <option value="">— склад —</option>
                      {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                    <button type="button" className="button button-secondary" onClick={() => map(w.id)}>Привязать</button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
