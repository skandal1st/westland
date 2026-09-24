'use client'

import { MapPin, Plus } from 'lucide-react'
import { FormEvent, useCallback, useEffect, useState } from 'react'

type Location = { id: string; name: string; city: string; address: string; contactName: string; contactPhone: string; isDefault: boolean }
const emptyDraft = { name: '', city: '', address: '', contactName: '', contactPhone: '' }

export function DeliveryPointsClient() {
  const [points, setPoints] = useState<Location[]>([])
  const [canCreate, setCanCreate] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState(emptyDraft)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/account/locations')
      if (!response.ok) throw new Error('load_failed')
      const data = await response.json()
      setPoints(data.locations ?? [])
      setCanCreate(data.canCreate === true)
    } catch {
      setError('Не удалось загрузить точки доставки. Обновите страницу и повторите.')
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      const response = await fetch('/api/account/locations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })
      if (response.ok) {
        setDraft(emptyDraft)
        setAdding(false)
        await load()
      } else {
        const data = await response.json().catch(() => ({}))
        setError(data.error === 'address_too_long' ? 'Город и адрес вместе должны занимать не более 255 символов. Сократите адрес.' : data.error === 'invalid_input' ? 'Укажите название, город и адрес точки.' : 'Не удалось сохранить точку. Обновите страницу и повторите.')
      }
    } catch {
      setError('Не удалось связаться с сервером. Проверьте подключение и повторите.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="account-page">
      <header><div><h1>Точки доставки</h1><p>{loading ? 'Загружаем доступные адреса…' : canCreate ? 'Добавьте адреса заведений или магазинов, куда будут доставляться заказы.' : 'Точки доставки, назначенные вам менеджером.'}</p></div>{canCreate ? <button className="button button-primary" type="button" disabled={saving} aria-expanded={adding} onClick={() => { setAdding((value) => !value); setError(null) }}><Plus /> Добавить точку</button> : null}</header>
      {error ? <p className="auth-error" role="alert">{error}</p> : null}
      {adding && canCreate ? (
        <form className="location-form" onSubmit={submit}>
          <h2>Новая точка</h2>
          <div className="form-row"><label>Название<input required maxLength={200} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Название точки" /></label><label>Город<input required maxLength={200} value={draft.city} onChange={(event) => setDraft({ ...draft, city: event.target.value })} placeholder="Город" /></label></div>
          <label>Адрес<input required maxLength={2000} value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="Улица, дом, помещение" /></label>
          <div className="form-row"><label>Контакт на точке<input maxLength={200} value={draft.contactName} onChange={(event) => setDraft({ ...draft, contactName: event.target.value })} placeholder="Имя сотрудника" /></label><label>Телефон<input type="tel" maxLength={100} value={draft.contactPhone} onChange={(event) => setDraft({ ...draft, contactPhone: event.target.value })} placeholder="+7 000 000-00-00" /></label></div>
          <div className="location-form-actions"><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить точку'}</button><button className="button button-secondary" type="button" disabled={saving} onClick={() => { setAdding(false); setDraft(emptyDraft); setError(null) }}>Отмена</button></div>
        </form>
      ) : null}
      {loading ? <p role="status">Загрузка точек доставки…</p> : points.length === 0 ? (
        <div className="locations-empty"><MapPin /><h2>Точек пока нет</h2><p>{canCreate ? 'Добавьте первую точку, чтобы выбрать её при оформлении заказа.' : 'Обратитесь к менеджеру для назначения точек доставки.'}</p></div>
      ) : (
        <div className="locations-list">{points.map((point) => <div className={'location-card' + (point.isDefault ? ' selected' : '')} key={point.id}><MapPin /><span><strong>{point.name}</strong><small>{point.city}, {point.address}</small><small>{point.contactName} · {point.contactPhone}</small></span>{point.isDefault ? <b>По умолчанию</b> : null}</div>)}</div>
      )}
    </main>
  )
}
