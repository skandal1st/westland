'use client'

import { useCallback, useEffect, useState } from 'react'

type Commerce = {
  locations: { id: string; code: string; name: string }[]
  priceBooks: { id: string; code: string; name: string; currency: string; isDefault: boolean }[]
  priceGroups: { id: string; code: string; name: string; priceBookId: string | null }[]
  channels: { id: string; code: string; name: string; paymentMethod: string; isActive: boolean; inventoryLocationId: string; priceBookId: string | null }[]
}
type Customer = { id: string; displayName: string; legalName: string; inn: string; priceGroupId: string | null; priceGroup: { code: string; name: string } | null }

export function CommercePanel() {
  const [data, setData] = useState<Commerce>({ locations: [], priceBooks: [], priceGroups: [], channels: [] })
  const [customers, setCustomers] = useState<Customer[]>([])
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [commerce, cust] = await Promise.all([fetch('/api/staff/commerce'), fetch('/api/staff/customers')])
    if (commerce.ok) setData(await commerce.json())
    if (cust.ok) setCustomers((await cust.json()).customers ?? [])
  }, [])
  useEffect(() => { load() }, [load])

  const create = async (body: Record<string, unknown>) => {
    setMessage(null)
    const response = await fetch('/api/staff/commerce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (response.ok) await load()
    else setMessage('Не удалось создать (нужна роль ADMIN и корректные поля).')
  }

  const assign = async (customerId: string, priceGroupId: string) => {
    if (!priceGroupId) return
    const response = await fetch(`/api/staff/customers/${customerId}/price-group`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ priceGroupId }) })
    if (response.ok) await load()
    else setMessage('Не удалось назначить группу.')
  }

  const submit = (kind: string) => (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const f = new FormData(event.currentTarget)
    const base = { kind, code: String(f.get('code') ?? ''), name: String(f.get('name') ?? '') }
    if (kind === 'priceBook') create({ ...base, currency: String(f.get('currency') || 'RUB'), isDefault: f.get('isDefault') === 'on' })
    else if (kind === 'priceGroup') create({ ...base, priceBookId: String(f.get('priceBookId') || '') || undefined })
    else if (kind === 'channel') create({ ...base, paymentMethod: String(f.get('paymentMethod') || 'BANK_TRANSFER'), inventoryLocationId: String(f.get('inventoryLocationId') || ''), priceBookId: String(f.get('priceBookId') || '') || undefined })
    else create(base)
    event.currentTarget.reset()
  }

  return (
    <div className="commerce-panel">
      {message ? <p className="auth-error" role="status">{message}</p> : null}

      <section>
        <h3>Склады</h3>
        <ul>{data.locations.map((l) => <li key={l.id}>{l.code} — {l.name}</li>)}</ul>
        <form className="form-row" onSubmit={submit('location')}><input name="code" placeholder="Код" required /><input name="name" placeholder="Название" required /><button className="button button-secondary">Добавить склад</button></form>
      </section>

      <section>
        <h3>Прайс-листы</h3>
        <ul>{data.priceBooks.map((b) => <li key={b.id}>{b.code} — {b.name} ({b.currency}){b.isDefault ? ' · по умолчанию' : ''}</li>)}</ul>
        <form className="form-row" onSubmit={submit('priceBook')}><input name="code" placeholder="Код" required /><input name="name" placeholder="Название" required /><input name="currency" placeholder="RUB" defaultValue="RUB" /><label><input type="checkbox" name="isDefault" /> по умолчанию</label><button className="button button-secondary">Добавить прайс</button></form>
      </section>

      <section>
        <h3>Ценовые группы</h3>
        <ul>{data.priceGroups.map((g) => <li key={g.id}>{g.code} — {g.name}</li>)}</ul>
        <form className="form-row" onSubmit={submit('priceGroup')}><input name="code" placeholder="Код" required /><input name="name" placeholder="Название" required /><select name="priceBookId"><option value="">— прайс —</option>{data.priceBooks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select><button className="button button-secondary">Добавить группу</button></form>
      </section>

      <section>
        <h3>Каналы (оплата + склад + прайс)</h3>
        <ul>{data.channels.map((c) => <li key={c.id}>{c.code} — {c.name} · {c.paymentMethod}{c.isActive ? '' : ' · выключен'}</li>)}</ul>
        <form className="form-row" onSubmit={submit('channel')}>
          <input name="code" placeholder="Код" required /><input name="name" placeholder="Название" required />
          <select name="paymentMethod"><option value="BANK_TRANSFER">Безнал</option><option value="CASH">Нал</option></select>
          <select name="inventoryLocationId" required><option value="">— склад —</option>{data.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
          <select name="priceBookId"><option value="">— прайс —</option>{data.priceBooks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          <button className="button button-secondary">Добавить канал</button>
        </form>
      </section>

      <section>
        <h3>Клиенты и ценовые группы</h3>
        <div className="moderation-head"><span>Компания</span><span>ИНН</span><span>Группа</span></div>
        {customers.map((customer) => (
          <div className="moderation-row" key={customer.id}>
            <span><strong>{customer.legalName}</strong></span>
            <span>{customer.inn}</span>
            <span className="moderation-actions">
              <select defaultValue={customer.priceGroupId ?? ''} onChange={(event) => assign(customer.id, event.target.value)}>
                <option value="">— не назначена —</option>
                {data.priceGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </span>
          </div>
        ))}
      </section>
    </div>
  )
}
