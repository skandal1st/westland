'use client'

import { Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'

export type AssignablePoint = { id: string; name: string; city: string; address: string }
export type PointAccount = { id: string; email: string; restricted: boolean; locationIds: string[] }

const emptyDraft = { name: '', city: '', address: '', contactName: '', contactPhone: '' }

export function BuyerPointAssignments({ user, locations, onSaved }: { user: PointAccount; locations: AssignablePoint[]; onSaved: () => Promise<void> }) {
  const [selected, setSelected] = useState(() => user.restricted ? user.locationIds : locations.map(point => point.id))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState(emptyDraft)

  async function save() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/staff/users/' + encodeURIComponent(user.id) + '/locations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locationIds: selected }),
      })
      if (!response.ok) throw new Error('save_failed')
      await onSaved()
    } catch {
      setError('Не удалось сохранить точки. Обновите список и повторите.')
    } finally {
      setBusy(false)
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/staff/users/' + encodeURIComponent(user.id) + '/locations/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
      if (!response.ok) {
        const result = await response.json().catch(() => ({}))
        if (result.error === 'address_too_long') throw new Error('address_too_long')
        if (result.error === 'invalid_input') throw new Error('invalid_input')
        throw new Error('create_failed')
      }
      setDraft(emptyDraft)
      setAdding(false)
      await onSaved()
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : 'create_failed'
      setError(code === 'address_too_long'
        ? 'Город и адрес вместе должны занимать не более 255 символов.'
        : code === 'invalid_input'
          ? 'Укажите название, город и адрес точки.'
          : 'Не удалось добавить точку покупателю. Проверьте данные и повторите.')
    } finally {
      setBusy(false)
    }
  }

  return <details className="buyer-point-manager">
    <summary>Точки: {user.email}</summary>
    <fieldset className="delivery-point-options" disabled={busy}>
      <legend>Разрешённые точки</legend>
      {!user.restricted ? <p>Сейчас аккаунт видит все точки компании. Сохранение закрепит только отмеченные.</p> : null}
      {locations.map(point => <label key={point.id}><input type="checkbox" checked={selected.includes(point.id)} onChange={event => {
        const checked = event.target.checked
        setSelected(previous => checked ? [...previous, point.id] : previous.filter(id => id !== point.id))
      }} /> {point.name} — {point.city}, {point.address}</label>)}
      {!locations.length ? <p>У компании ещё нет точек доставки.</p> : null}
      {!selected.length ? <p>Покупатель сможет добавить собственную точку в личном кабинете.</p> : null}
      <button type="button" onClick={save}>{busy ? 'Сохранение…' : 'Сохранить доступ'}</button>
    </fieldset>

    <button className="button button-secondary staff-location-toggle" type="button" disabled={busy} aria-expanded={adding} onClick={() => {
      setAdding(value => !value)
      setError('')
    }}><Plus /> Добавить точку покупателю</button>

    {adding ? <form className="location-form staff-location-form" onSubmit={create}>
      <h4>Новая точка для {user.email}</h4>
      <div className="form-row">
        <label>Название<input required maxLength={200} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder="Название точки" /></label>
        <label>Город<input required maxLength={200} value={draft.city} onChange={event => setDraft(current => ({ ...current, city: event.target.value }))} placeholder="Город" /></label>
      </div>
      <label>Адрес<input required maxLength={2000} value={draft.address} onChange={event => setDraft(current => ({ ...current, address: event.target.value }))} placeholder="Улица, дом, помещение" /></label>
      <div className="form-row">
        <label>Контакт на точке<input maxLength={200} value={draft.contactName} onChange={event => setDraft(current => ({ ...current, contactName: event.target.value }))} placeholder="Имя сотрудника" /></label>
        <label>Телефон<input type="tel" maxLength={100} value={draft.contactPhone} onChange={event => setDraft(current => ({ ...current, contactPhone: event.target.value }))} placeholder="+7 000 000-00-00" /></label>
      </div>
      <div className="location-form-actions">
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Сохранение…' : 'Добавить и назначить'}</button>
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => {
          setAdding(false)
          setDraft(emptyDraft)
          setError('')
        }}>Отмена</button>
      </div>
    </form> : null}
    {error ? <p className="auth-error" role="alert">{error}</p> : null}
  </details>
}
