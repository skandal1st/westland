'use client'

import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'

type Promotion = {
  id: string
  name: string
  type: 'PERCENTAGE' | 'FIXED_AMOUNT'
  value: number
  priority: number
  stackable: boolean
  isActive: boolean
  startsAt: string | null
  endsAt: string | null
}

/** Backoffice promotions management (plan §M9). Promotions discount the resolved price. */
export function PromoPanel() {
  const [promotions, setPromotions] = useState<Promotion[]>([])
  const [name, setName] = useState('')
  const [type, setType] = useState<'PERCENTAGE' | 'FIXED_AMOUNT'>('PERCENTAGE')
  const [value, setValue] = useState('10')
  const [priority, setPriority] = useState('100')
  const [stackable, setStackable] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const data = await fetch('/api/staff/promotions').then((r) => (r.ok ? r.json() : { promotions: [] }))
    setPromotions(data.promotions ?? [])
  }, [])

  useEffect(() => { load() }, [load])

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch('/api/staff/promotions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), type, value: Number(value), priority: Number(priority), stackable }),
      })
      if (response.ok) { setName(''); await load() } else setMessage('Не удалось создать промо (проверьте значение).')
    } finally { setBusy(false) }
  }

  const toggle = async (promo: Promotion) => {
    await fetch(`/api/staff/promotions/${promo.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ isActive: !promo.isActive }),
    })
    await load()
  }

  const remove = async (id: string) => {
    await fetch(`/api/staff/promotions/${id}`, { method: 'DELETE' })
    await load()
  }

  const fmtValue = (p: Promotion) => (p.type === 'PERCENTAGE' ? `−${p.value}%` : `−${p.value.toLocaleString('ru-RU')} ₽`)

  return (
    <div className="moderation-list">
      <div className="staff-toolbar" style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название акции" aria-label="Название акции" />
        <select value={type} onChange={(e) => setType(e.target.value as 'PERCENTAGE' | 'FIXED_AMOUNT')} aria-label="Тип скидки">
          <option value="PERCENTAGE">Процент</option>
          <option value="FIXED_AMOUNT">Фикс. сумма</option>
        </select>
        <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" placeholder="Значение" aria-label="Значение скидки" style={{ width: 90 }} />
        <input value={priority} onChange={(e) => setPriority(e.target.value)} inputMode="numeric" placeholder="Приоритет" aria-label="Приоритет" style={{ width: 90 }} />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={stackable} onChange={(e) => setStackable(e.target.checked)} /> Складывается</label>
        <button type="button" className="button button-primary" disabled={busy} onClick={create}>Добавить акцию</button>
      </div>
      {message ? <p className="auth-error" role="status">{message}</p> : null}

      <div className="moderation-head"><span>Акция</span><span>Скидка</span><span>Приоритет</span><span>Действие</span></div>
      {promotions.length === 0 ? <p className="staff-placeholder">Промо-акций нет. Скидка применяется к цене в каталоге.</p> : null}
      {promotions.map((promo) => (
        <div className="moderation-row" key={promo.id}>
          <span><strong>{promo.name}</strong><small>{promo.stackable ? 'складывается' : 'не складывается'}</small></span>
          <span>{fmtValue(promo)}</span>
          <span>{promo.priority}</span>
          <span className="moderation-actions">
            <button type="button" onClick={() => toggle(promo)}>{promo.isActive ? 'Выключить' : 'Включить'}</button>
            <button type="button" aria-label={'Удалить ' + promo.name} onClick={() => remove(promo.id)}><Trash2 size={14} /></button>
          </span>
        </div>
      ))}
    </div>
  )
}
