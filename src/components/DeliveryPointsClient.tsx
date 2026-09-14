'use client'

import { MapPin, Plus } from 'lucide-react'
import { FormEvent, useCallback, useEffect, useState } from 'react'

type Location = { id: string; name: string; city: string; address: string; contactName: string; contactPhone: string; isDefault: boolean }
const emptyDraft = { name: '', city: '', address: '', contactName: '', contactPhone: '' }

export function DeliveryPointsClient() {
  const [points, setPoints] = useState<Location[]>([])
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState(emptyDraft)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/account/locations')
    if (response.ok) setPoints((await response.json()).locations ?? [])
  }, [])
  useEffect(() => { load() }, [load])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    const response = await fetch('/api/account/locations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })
    if (response.ok) { setDraft(emptyDraft); setAdding(false); await load() }
    else setError('Не удалось сохранить точку (нужна привязанная компания).')
  }

  return (
    <main className="account-page">
      <header><div><h1>Точки доставки</h1><p>Добавьте адреса заведений или магазинов, куда будут доставляться заказы.</p></div><button className="button button-primary" type="button" onClick={() => setAdding((value) => !value)}><Plus /> Добавить точку</button></header>
      {adding ? (
        <form className="location-form" onSubmit={submit}>
          <h2>Новая точка</h2>
          <div className="form-row"><label>Название<input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Например, бар на Невском" /></label><label>Город<input required value={draft.city} onChange={(event) => setDraft({ ...draft, city: event.target.value })} placeholder="Санкт-Петербург" /></label></div>
          <label>Адрес<input required value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="Улица, дом, помещение" /></label>
          <div className="form-row"><label>Контакт на точке<input value={draft.contactName} onChange={(event) => setDraft({ ...draft, contactName: event.target.value })} placeholder="Имя сотрудника" /></label><label>Телефон<input type="tel" value={draft.contactPhone} onChange={(event) => setDraft({ ...draft, contactPhone: event.target.value })} placeholder="+7 000 000-00-00" /></label></div>
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
          <div className="location-form-actions"><button className="button button-primary" type="submit">Сохранить точку</button><button className="button button-secondary" type="button" onClick={() => setAdding(false)}>Отмена</button></div>
        </form>
      ) : null}
      {points.length === 0 ? (
        <div className="locations-empty"><MapPin /><h2>Точек пока нет</h2><p>Добавьте первую точку, чтобы выбрать её при оформлении заказа.</p></div>
      ) : (
        <div className="locations-list">{points.map((point) => <div className={'location-card' + (point.isDefault ? ' selected' : '')} key={point.id}><MapPin /><span><strong>{point.name}</strong><small>{point.city}, {point.address}</small><small>{point.contactName} · {point.contactPhone}</small></span>{point.isDefault ? <b>По умолчанию</b> : null}</div>)}</div>
      )}
    </main>
  )
}
