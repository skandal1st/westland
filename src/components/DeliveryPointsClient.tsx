'use client'

import { MapPin, Plus } from 'lucide-react'
import { FormEvent, useState } from 'react'
import { useCommerceStore } from '@/store/commerce-store'

const emptyDraft = { name: '', city: '', address: '', contactName: '', contactPhone: '' }

export function DeliveryPointsClient() {
  const points = useCommerceStore((state) => state.deliveryPoints)
  const selectedId = useCommerceStore((state) => state.selectedDeliveryPointId)
  const addPoint = useCommerceStore((state) => state.addDeliveryPoint)
  const selectPoint = useCommerceStore((state) => state.setSelectedDeliveryPoint)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState(emptyDraft)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    addPoint(draft)
    setDraft(emptyDraft)
    setAdding(false)
  }

  return (
    <main className="account-page">
      <header><div><h1>Точки доставки</h1><p>Добавьте адреса заведений или магазинов, куда будут доставляться заказы.</p></div><button className="button button-primary" type="button" onClick={() => setAdding((value) => !value)}><Plus /> Добавить точку</button></header>
      {adding ? (
        <form className="location-form" onSubmit={submit}>
          <h2>Новая точка</h2>
          <div className="form-row"><label>Название<input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Например, бар на Невском" /></label><label>Город<input required value={draft.city} onChange={(event) => setDraft({ ...draft, city: event.target.value })} placeholder="Санкт-Петербург" /></label></div>
          <label>Адрес<input required value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="Улица, дом, помещение" /></label>
          <div className="form-row"><label>Контакт на точке<input required value={draft.contactName} onChange={(event) => setDraft({ ...draft, contactName: event.target.value })} placeholder="Имя сотрудника" /></label><label>Телефон<input required type="tel" value={draft.contactPhone} onChange={(event) => setDraft({ ...draft, contactPhone: event.target.value })} placeholder="+7 000 000-00-00" /></label></div>
          <div className="location-form-actions"><button className="button button-primary" type="submit">Сохранить точку</button><button className="button button-secondary" type="button" onClick={() => setAdding(false)}>Отмена</button></div>
        </form>
      ) : null}
      {points.length === 0 ? (
        <div className="locations-empty"><MapPin /><h2>Точек пока нет</h2><p>Добавьте первую точку, чтобы выбрать её при оформлении заказа.</p></div>
      ) : (
        <div className="locations-list">{points.map((point) => <button type="button" className={selectedId === point.id ? 'selected' : ''} key={point.id} onClick={() => selectPoint(point.id)}><MapPin /><span><strong>{point.name}</strong><small>{point.city}, {point.address}</small><small>{point.contactName} · {point.contactPhone}</small></span><b>{selectedId === point.id ? 'По умолчанию' : 'Выбрать'}</b></button>)}</div>
      )}
    </main>
  )
}
