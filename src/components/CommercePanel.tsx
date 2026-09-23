'use client'

import { useCallback, useEffect, useState } from 'react'
import { BuyerPointAssignments, type AssignablePoint, type PointAccount } from './BuyerPointAssignments'

type Commerce = {
  locations: { id: string; code: string; name: string }[]
  priceBooks: { id: string; code: string; name: string; currency: string; isDefault: boolean }[]
  priceGroups: { id: string; code: string; name: string; priceBookId: string | null }[]
  channels: { id: string; code: string; name: string; paymentMethod: string; isActive: boolean; inventoryLocationId: string; priceBookId: string | null }[]
}

type Customer = {
  locations: AssignablePoint[]
  users: PointAccount[]
  id: string
  displayName: string
  legalName: string
  inn: string
  priceGroupId: string | null
  priceGroup: { code: string; name: string } | null
}

type CommerceView = 'customers' | 'pricing' | 'warehouses'

const EMPTY_COMMERCE: Commerce = { locations: [], priceBooks: [], priceGroups: [], channels: [] }

export function CommercePanel({ view }: { view: CommerceView }) {
  const [data, setData] = useState<Commerce>(EMPTY_COMMERCE)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setMessage(null)
    try {
      const commerceRequest = fetch('/api/staff/commerce')
      const customersRequest = view === 'customers' ? fetch('/api/staff/customers') : Promise.resolve(null)
      const [commerce, customerResponse] = await Promise.all([commerceRequest, customersRequest])

      if (!commerce.ok || (customerResponse && !customerResponse.ok)) throw new Error('load_failed')
      setData(await commerce.json())
      if (customerResponse) setCustomers((await customerResponse.json()).customers ?? [])
    } catch {
      setMessage('Не удалось загрузить данные. Обновите страницу или повторите позже.')
    } finally {
      setLoading(false)
    }
  }, [view])

  useEffect(() => { void load() }, [load])

  const create = async (body: Record<string, unknown>) => {
    setMessage(null)
    const response = await fetch('/api/staff/commerce', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      setMessage('Не удалось сохранить. Проверьте поля и права администратора.')
      return false
    }
    await load()
    return true
  }

  const assign = async (customerId: string, priceGroupId: string) => {
    if (!priceGroupId) return
    setMessage(null)
    const response = await fetch(`/api/staff/customers/${customerId}/price-group`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ priceGroupId }),
    })
    if (response.ok) await load()
    else setMessage('Не удалось назначить ценовую группу. Повторите попытку.')
  }

  const submit = (kind: string) => async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    const base = { kind, code: String(fields.get('code') ?? ''), name: String(fields.get('name') ?? '') }
    let saved = false

    if (kind === 'priceBook') saved = await create({ ...base, currency: String(fields.get('currency') || 'RUB'), isDefault: fields.get('isDefault') === 'on' })
    else if (kind === 'priceGroup') saved = await create({ ...base, priceBookId: String(fields.get('priceBookId') || '') || undefined })
    else if (kind === 'channel') saved = await create({
      ...base,
      paymentMethod: String(fields.get('paymentMethod') || 'BANK_TRANSFER'),
      inventoryLocationId: String(fields.get('inventoryLocationId') || ''),
      priceBookId: String(fields.get('priceBookId') || '') || undefined,
    })
    else saved = await create(base)

    if (saved) form.reset()
  }

  if (loading) return <p className="staff-placeholder" role="status">Загрузка…</p>

  return (
    <div className="commerce-panel">
      {message ? <p className="auth-error" role="status">{message}</p> : null}

      {view === 'warehouses' ? <>
        <section>
          <div className="commerce-section-heading"><div><h3>Склады</h3><p>Места хранения, из которых доступны остатки.</p></div></div>
          {data.locations.length > 0 ? <ul>{data.locations.map((location) => <li key={location.id}><strong>{location.name}</strong><span>{location.code}</span></li>)}</ul> : <p className="commerce-empty">Склады ещё не добавлены.</p>}
          <form className="form-row" onSubmit={submit('location')}><input name="code" aria-label="Код склада" placeholder="Код" required /><input name="name" aria-label="Название склада" placeholder="Название" required /><button className="button button-secondary">Добавить склад</button></form>
        </section>

        <section>
          <div className="commerce-section-heading"><div><h3>Каналы продаж</h3><p>Способ оплаты определяет склад и применяемый прайс.</p></div></div>
          {data.channels.length > 0 ? <ul>{data.channels.map((channel) => <li key={channel.id}><strong>{channel.name}</strong><span>{channel.code} · {channel.paymentMethod === 'CASH' ? 'Наличные' : 'Безналичная оплата'}{channel.isActive ? '' : ' · выключен'}</span></li>)}</ul> : <p className="commerce-empty">Каналы продаж ещё не настроены.</p>}
          <form className="form-row" onSubmit={submit('channel')}>
            <input name="code" aria-label="Код канала" placeholder="Код" required /><input name="name" aria-label="Название канала" placeholder="Название" required />
            <select name="paymentMethod" aria-label="Способ оплаты"><option value="BANK_TRANSFER">Безналичная оплата</option><option value="CASH">Наличные</option></select>
            <select name="inventoryLocationId" aria-label="Склад" required><option value="">— склад —</option>{data.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select>
            <select name="priceBookId" aria-label="Прайс-лист"><option value="">— прайс —</option>{data.priceBooks.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</select>
            <button className="button button-secondary">Добавить канал</button>
          </form>
        </section>
      </> : null}

      {view === 'pricing' ? <>
        <section>
          <div className="commerce-section-heading"><div><h3>Прайс-листы</h3><p>Наборы цен, которые используются группами и каналами продаж.</p></div></div>
          {data.priceBooks.length > 0 ? <ul>{data.priceBooks.map((book) => <li key={book.id}><strong>{book.name}</strong><span>{book.code} · {book.currency}{book.isDefault ? ' · по умолчанию' : ''}</span></li>)}</ul> : <p className="commerce-empty">Прайс-листы ещё не добавлены.</p>}
          <form className="form-row" onSubmit={submit('priceBook')}><input name="code" aria-label="Код прайс-листа" placeholder="Код" required /><input name="name" aria-label="Название прайс-листа" placeholder="Название" required /><input name="currency" aria-label="Валюта" placeholder="RUB" defaultValue="RUB" /><label><input type="checkbox" name="isDefault" /> По умолчанию</label><button className="button button-secondary">Добавить прайс</button></form>
        </section>

        <section>
          <div className="commerce-section-heading"><div><h3>Ценовые группы</h3><p>Группа назначается клиенту и определяет доступный ему прайс.</p></div></div>
          {data.priceGroups.length > 0 ? <ul>{data.priceGroups.map((group) => <li key={group.id}><strong>{group.name}</strong><span>{group.code} · {data.priceBooks.find((book) => book.id === group.priceBookId)?.name ?? 'Прайс не выбран'}</span></li>)}</ul> : <p className="commerce-empty">Ценовые группы ещё не добавлены.</p>}
          <form className="form-row" onSubmit={submit('priceGroup')}><input name="code" aria-label="Код ценовой группы" placeholder="Код" required /><input name="name" aria-label="Название ценовой группы" placeholder="Название" required /><select name="priceBookId" aria-label="Прайс-лист"><option value="">— прайс —</option>{data.priceBooks.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</select><button className="button button-secondary">Добавить группу</button></form>
        </section>
      </> : null}

      {view === 'customers' ? <section>
        <div className="commerce-section-heading"><div><h3>Компании</h3><p>Назначьте каждому покупателю ценовую группу.</p></div><span>{customers.length}</span></div>
        {customers.length > 0 ? <div className="customer-table">
          <div className="moderation-head"><span>Компания</span><span>ИНН</span><span>Ценовая группа</span></div>
          {customers.map((customer) => (
            <div className="moderation-row" key={customer.id}>
              <div><strong>{customer.legalName || customer.displayName}</strong>{customer.displayName && customer.displayName !== customer.legalName ? <small>{customer.displayName}</small> : null}
                {(customer.users ?? []).map(user => <BuyerPointAssignments key={user.id + ':' + user.restricted + ':' + user.locationIds.join(',')} user={user} locations={customer.locations ?? []} onSaved={load} />)}
              </div>
              <span>{customer.inn}</span>
              <span className="moderation-actions">
                <select aria-label={`Ценовая группа для ${customer.legalName || customer.displayName}`} value={customer.priceGroupId ?? ''} onChange={(event) => void assign(customer.id, event.target.value)}>
                  <option value="">— не назначена —</option>
                  {data.priceGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
              </span>
            </div>
          ))}
        </div> : <p className="commerce-empty">Одобренные клиенты появятся здесь после модерации.</p>}
      </section> : null}
    </div>
  )
}
