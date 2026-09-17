'use client'

import { useCallback, useEffect, useState } from 'react'

type Requisites = {
  companyName?: string; inn?: string; kpp?: string; city?: string; legalAddress?: string
  phone?: string; email?: string
  bank?: { name?: string; bik?: string; account?: string; corAccount?: string }
  directorName?: string; accountantName?: string
  vatEnabled?: boolean; vatRate?: number; paymentPurpose?: string
}

type Form = {
  companyName: string; inn: string; kpp: string; city: string; legalAddress: string; phone: string; email: string
  bankName: string; bankBik: string; bankAccount: string; bankCor: string
  directorName: string; accountantName: string
  vatEnabled: boolean; vatRate: string; paymentPurpose: string
}

const empty: Form = {
  companyName: '', inn: '', kpp: '', city: '', legalAddress: '', phone: '', email: '',
  bankName: '', bankBik: '', bankAccount: '', bankCor: '',
  directorName: '', accountantName: '', vatEnabled: false, vatRate: '', paymentPurpose: '',
}

type TextField = Exclude<keyof Form, 'vatEnabled'>

export function SettingsPanel() {
  const [form, setForm] = useState<Form>(empty)
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch('/api/staff/settings')
    if (!response.ok) return
    const q: Requisites = (await response.json()).requisites ?? {}
    setForm({
      companyName: q.companyName ?? '', inn: q.inn ?? '', kpp: q.kpp ?? '', city: q.city ?? '',
      legalAddress: q.legalAddress ?? '', phone: q.phone ?? '', email: q.email ?? '',
      bankName: q.bank?.name ?? '', bankBik: q.bank?.bik ?? '', bankAccount: q.bank?.account ?? '', bankCor: q.bank?.corAccount ?? '',
      directorName: q.directorName ?? '', accountantName: q.accountantName ?? '',
      vatEnabled: Boolean(q.vatEnabled), vatRate: q.vatRate != null ? String(q.vatRate) : '', paymentPurpose: q.paymentPurpose ?? '',
    })
  }, [])
  useEffect(() => { load() }, [load])

  const set = (key: TextField) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }))

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    setMessage(null)
    const payload = {
      companyName: form.companyName, inn: form.inn, kpp: form.kpp, city: form.city,
      legalAddress: form.legalAddress, phone: form.phone, email: form.email,
      bank: { name: form.bankName, bik: form.bankBik, account: form.bankAccount, corAccount: form.bankCor },
      directorName: form.directorName, accountantName: form.accountantName,
      vatEnabled: form.vatEnabled, vatRate: form.vatRate ? Number(form.vatRate) : undefined,
      paymentPurpose: form.paymentPurpose,
    }
    const response = await fetch('/api/staff/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    setSaving(false)
    if (response.ok) { setMessage('Настройки сохранены.'); await load() }
    else if (response.status === 403) setMessage('Сохранение доступно только роли ADMIN.')
    else setMessage('Не удалось сохранить настройки.')
  }

  return (
    <div className="settings-panel">
      {message ? <p className="settings-message" role="status">{message}</p> : null}
      <form onSubmit={save}>
        <section>
          <h3>Реквизиты компании</h3>
          <p className="settings-note">Используются как реквизиты продавца в PDF-счёте, если они не заданы для конкретного канала.</p>
          <div className="settings-grid">
            <label className="wide">Название компании<input value={form.companyName} onChange={set('companyName')} placeholder="ООО «Компания»" /></label>
            <label>ИНН<input value={form.inn} onChange={set('inn')} inputMode="numeric" /></label>
            <label>КПП<input value={form.kpp} onChange={set('kpp')} inputMode="numeric" /></label>
            <label>Город<input value={form.city} onChange={set('city')} placeholder="Город продавца" /></label>
            <label>Телефон<input value={form.phone} onChange={set('phone')} type="tel" /></label>
            <label className="wide">Юридический адрес<input value={form.legalAddress} onChange={set('legalAddress')} placeholder="Индекс, город, улица, дом" /></label>
            <label className="wide">E-mail<input value={form.email} onChange={set('email')} type="email" /></label>
          </div>
        </section>

        <section>
          <h3>Банковские реквизиты</h3>
          <div className="settings-grid">
            <label className="wide">Банк<input value={form.bankName} onChange={set('bankName')} /></label>
            <label>БИК<input value={form.bankBik} onChange={set('bankBik')} inputMode="numeric" /></label>
            <label>Расчётный счёт<input value={form.bankAccount} onChange={set('bankAccount')} inputMode="numeric" /></label>
            <label>Корр. счёт<input value={form.bankCor} onChange={set('bankCor')} inputMode="numeric" /></label>
          </div>
        </section>

        <section>
          <h3>НДС и подписи</h3>
          <div className="settings-grid">
            <label className="check"><input type="checkbox" checked={form.vatEnabled} onChange={(event) => setForm((prev) => ({ ...prev, vatEnabled: event.target.checked }))} /> Плательщик НДС</label>
            <label>Ставка НДС, %<input value={form.vatRate} onChange={set('vatRate')} type="number" min="0" max="100" disabled={!form.vatEnabled} /></label>
            <label>Директор<input value={form.directorName} onChange={set('directorName')} /></label>
            <label>Главный бухгалтер<input value={form.accountantName} onChange={set('accountantName')} /></label>
            <label className="wide">Назначение платежа<input value={form.paymentPurpose} onChange={set('paymentPurpose')} placeholder="Оплата по счёту" /></label>
          </div>
        </section>

        <div className="settings-actions"><button className="button button-primary" type="submit" disabled={saving}>{saving ? 'Сохранение…' : 'Сохранить настройки'}</button></div>
      </form>
    </div>
  )
}
