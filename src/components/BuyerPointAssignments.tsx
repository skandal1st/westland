'use client'
import { useState } from 'react'
export type AssignablePoint = { id: string; name: string; city: string; address: string }
export type PointAccount = { id: string; email: string; restricted: boolean; locationIds: string[] }
export function BuyerPointAssignments({ user, locations, onSaved }: { user: PointAccount; locations: AssignablePoint[]; onSaved: () => Promise<void> }) {
  const [selected, setSelected] = useState(() => user.restricted ? user.locationIds : locations.map(point => point.id))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function save() {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/staff/users/' + user.id + '/locations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locationIds: selected }) })
      if (!response.ok) throw new Error('save_failed')
      await onSaved()
    } catch { setError('Не удалось сохранить точки. Обновите список и повторите.') }
    finally { setBusy(false) }
  }
  return <details><summary>Точки: {user.email}</summary>
    <fieldset className="delivery-point-options" disabled={busy}><legend>Разрешённые точки</legend>
      {!user.restricted ? <p>Ранее аккаунт имел доступ ко всем точкам компании. Сохранение закрепит только отмеченные.</p> : null}
      {locations.map(point => <label key={point.id} ><input type="checkbox" checked={selected.includes(point.id)} onChange={event => {
        const checked = event.target.checked
        setSelected(previous => checked ? [...previous, point.id] : previous.filter(id => id !== point.id))
      }} /> {point.name} — {point.city}, {point.address}</label>)}
      {!locations.length ? <p>Точки компании ещё не загружены.</p> : null}
      {!selected.length ? <p>Пользователь может добавить новую точку самостоятельно.</p> : null}
      <button type="button" onClick={save}>{busy ? 'Сохранение…' : 'Сохранить точки'}</button>
    </fieldset>{error ? <p role="alert">{error}</p> : null}
  </details>
}
