'use client'

import { Pencil, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { BuyerPointAssignments, type AssignablePoint, type PointAccount } from './BuyerPointAssignments'

type Channel = { id: string; code: string; name: string; paymentMethod: string; isActive: boolean; inventoryLocationId: string; priceBookId: string | null }

type Commerce = {
  locations: { id: string; code: string; name: string }[]
  priceBooks: { id: string; code: string; name: string; currency: string; isDefault: boolean }[]
  priceGroups: { id: string; code: string; name: string; priceBookId: string | null }[]
  channels: Channel[]
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
const EMPTY_CHANNEL = { code: '', name: '', paymentMethod: 'BANK_TRANSFER', inventoryLocationId: '', priceBookId: '', isActive: true }

export function CommercePanel({ view }: { view: CommerceView }) {
  const [data, setData] = useState<Commerce>(EMPTY_COMMERCE)
  const [customers, setCustomers] = useState<Customer[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null)
  const [channelDraft, setChannelDraft] = useState(EMPTY_CHANNEL)
  const [channelBusy, setChannelBusy] = useState(false)
  const [channelMessage, setChannelMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

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
    else saved = await create(base)

    if (saved) form.reset()
  }

  const editChannel = (channel: Channel) => {
    setEditingChannelId(channel.id)
    setChannelDraft({
      code: channel.code,
      name: channel.name,
      paymentMethod: channel.paymentMethod,
      inventoryLocationId: channel.inventoryLocationId,
      priceBookId: channel.priceBookId ?? '',
      isActive: channel.isActive,
    })
    setChannelMessage(null)
  }

  const resetChannelForm = () => {
    setEditingChannelId(null)
    setChannelDraft(EMPTY_CHANNEL)
  }

  const saveChannel = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setChannelBusy(true)
    setChannelMessage(null)
    const editing = Boolean(editingChannelId)
    const payload = {
      code: channelDraft.code,
      name: channelDraft.name,
      paymentMethod: channelDraft.paymentMethod,
      inventoryLocationId: channelDraft.inventoryLocationId,
      priceBookId: channelDraft.priceBookId || null,
      isActive: channelDraft.isActive,
    }
    try {
      const response = await fetch(editing ? `/api/staff/commerce/channels/${editingChannelId}` : '/api/staff/commerce', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(editing ? payload : { kind: 'channel', ...payload, priceBookId: payload.priceBookId ?? undefined }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        const text = result.error === 'CODE_EXISTS'
          ? 'Канал с таким кодом уже существует. Укажите другой код.'
          : result.error === 'INVALID_REFERENCE'
            ? 'Выбранный склад или прайс-лист больше недоступен. Обновите страницу и выберите снова.'
            : result.error === 'NOT_FOUND'
              ? 'Канал уже удалён или недоступен. Обновите страницу.'
              : 'Не удалось сохранить канал. Проверьте заполнение полей и повторите.'
        setChannelMessage({ kind: 'error', text })
        return
      }
      await load()
      resetChannelForm()
      setChannelMessage({ kind: 'success', text: editing ? 'Изменения канала сохранены.' : 'Канал продаж создан.' })
    } catch {
      setChannelMessage({ kind: 'error', text: 'Не удалось связаться с сервером. Проверьте подключение и повторите.' })
    } finally {
      setChannelBusy(false)
    }
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
          {data.channels.length > 0 ? <ul className="commerce-channel-list">{data.channels.map((channel) => <li className={editingChannelId === channel.id ? 'editing' : ''} key={channel.id}>
            <span><strong>{channel.name}</strong><small>{channel.code} · {channel.paymentMethod === 'CASH' ? 'Наличные' : 'Безналичная оплата'} · {data.locations.find(location => location.id === channel.inventoryLocationId)?.name ?? 'Склад не найден'}{channel.isActive ? '' : ' · выключен'}</small></span>
            <button className="commerce-edit-button" type="button" aria-expanded={editingChannelId === channel.id} onClick={() => editChannel(channel)}><Pencil />Изменить</button>
          </li>)}</ul> : <p className="commerce-empty">Каналы продаж ещё не настроены.</p>}
          <form className="channel-editor" onSubmit={saveChannel}>
            <div className="channel-editor-heading"><h4>{editingChannelId ? 'Редактирование канала' : 'Новый канал'}</h4>{editingChannelId ? <button type="button" onClick={resetChannelForm}><X />Отменить</button> : null}</div>
            <div className="channel-editor-fields">
              <label>Код<input value={channelDraft.code} onChange={event => setChannelDraft(value => ({ ...value, code: event.target.value }))} required maxLength={100} autoComplete="off" /></label>
              <label>Название<input value={channelDraft.name} onChange={event => setChannelDraft(value => ({ ...value, name: event.target.value }))} required maxLength={200} /></label>
              <label>Способ оплаты<select value={channelDraft.paymentMethod} onChange={event => setChannelDraft(value => ({ ...value, paymentMethod: event.target.value }))}><option value="BANK_TRANSFER">Безналичная оплата</option><option value="CASH">Наличные</option></select></label>
              <label>Склад<select required value={channelDraft.inventoryLocationId} onChange={event => setChannelDraft(value => ({ ...value, inventoryLocationId: event.target.value }))}><option value="">Выберите склад</option>{data.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>
              <label>Прайс-лист<select value={channelDraft.priceBookId} onChange={event => setChannelDraft(value => ({ ...value, priceBookId: event.target.value }))}><option value="">Без отдельного прайса</option>{data.priceBooks.map((book) => <option key={book.id} value={book.id}>{book.name}</option>)}</select></label>
              <label className="channel-active"><input type="checkbox" checked={channelDraft.isActive} onChange={event => setChannelDraft(value => ({ ...value, isActive: event.target.checked }))} />Канал активен и доступен покупателям</label>
            </div>
            <button className="button button-secondary" disabled={channelBusy}>{channelBusy ? 'Сохранение…' : editingChannelId ? 'Сохранить изменения' : 'Добавить канал'}</button>
          </form>
          {channelMessage ? <p className={channelMessage.kind === 'error' ? 'auth-error' : 'channel-success'} role={channelMessage.kind === 'error' ? 'alert' : 'status'}>{channelMessage.text}</p> : null}
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
        <div className="commerce-section-heading"><div><h3>Компании</h3><p>Назначайте ценовые группы и управляйте точками доставки покупателей.</p></div><span>{customers.length}</span></div>
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
