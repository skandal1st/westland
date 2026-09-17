'use client'

import NextImage from 'next/image'
import { Banknote, Boxes, Building2, Check, CircleUserRound, ClipboardList, Image as ImageIcon, PackageCheck, Settings, ShieldCheck, ShoppingBag, Tag, Users, X } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'
import { useCallback, useEffect, useState } from 'react'
import { CatalogAdminPanel } from '@/components/CatalogAdminPanel'
import { IntegrationsPanel } from '@/components/IntegrationsPanel'
import { CommercePanel } from '@/components/CommercePanel'
import { ContentPanel } from '@/components/ContentPanel'
import { PromoPanel } from '@/components/PromoPanel'
import { LicensePanel } from '@/components/LicensePanel'
import { OrdersPanel } from '@/components/OrdersPanel'
import { SettingsPanel } from '@/components/SettingsPanel'
import { useStoreProfile } from '@/lib/store-profile-context'

type PendingRequest = {
  id: string
  email: string
  contactName: string
  legalName: string
  inn: string
}

export function StaffDashboard() {
  const { data: session } = useSession()
  const profile = useStoreProfile()
  const [section, setSection] = useState('Модерация')
  const [registrations, setRegistrations] = useState<PendingRequest[]>([])
  const [priceGroups, setPriceGroups] = useState<{ id: string; name: string }[]>([])
  const [groupChoice, setGroupChoice] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)

  const loadPending = useCallback(async () => {
    const response = await fetch('/api/staff/registrations?status=PENDING')
    if (response.ok) {
      const data = await response.json()
      setRegistrations(data.requests ?? [])
    }
  }, [])

  useEffect(() => {
    loadPending()
    fetch('/api/staff/commerce').then((r) => (r.ok ? r.json() : null)).then((data) => { if (data) setPriceGroups(data.priceGroups ?? []) })
  }, [loadPending])

  const moderate = async (id: string, action: 'approve' | 'reject') => {
    setBusyId(id)
    try {
      const payload = action === 'reject' ? { comment: 'Отклонено сотрудником' } : { priceGroupId: groupChoice[id] || undefined }
      const response = await fetch(`/api/staff/registrations/${id}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (response.ok) await loadPending()
    } finally {
      setBusyId(null)
    }
  }

  const navigation = [
    ['Заказы', ClipboardList], ['Модерация', Users], ['Товары', Boxes], ['Клиенты', Building2],
    ['Ценовые группы', ShoppingBag], ['Контент', ImageIcon], ['Промо', Tag], ['Склады', Banknote], ['Интеграции', PackageCheck], ['Лицензия', ShieldCheck], ['Настройки', Settings],
  ] as const
  const pendingCount = registrations.length
  const actionLabel = section === 'Товары' ? 'Добавить товар' : section === 'Заказы' ? 'Создать заказ' : ''

  return (
    <main className="staff-shell">
      <aside className="staff-nav">
        <div className="staff-brand"><NextImage src="/brand/westside-logo.png" alt={profile.identity.name} width={88} height={88} priority /><span>Back office</span></div>
        {navigation.map(([label, Icon]) => <button key={label} className={section === label ? 'active' : ''} onClick={() => setSection(label)}><Icon />{label}{label === 'Модерация' && pendingCount > 0 ? <b>{pendingCount}</b> : null}</button>)}
        <div className="staff-user"><CircleUserRound /><span>{session?.user?.name ?? 'Сотрудник'}<small>{session?.user?.email ?? ''}</small></span><button type="button" className="staff-signout" onClick={() => signOut({ callbackUrl: '/login' })}>Выйти</button></div>
      </aside>
      <section className="staff-content">
        <header><div><h1>{section}</h1><p>{profile.identity.name} · back office</p></div>{actionLabel ? <button className="button button-primary">{actionLabel}</button> : null}</header>

        {section === 'Заказы' ? <OrdersPanel /> : null}

        {section === 'Модерация' ? (
          <div className="moderation-list">
            <div className="moderation-head"><span>Компания</span><span>Контакт</span><span>ИНН</span><span>Решение</span></div>
            {registrations.length === 0 ? <p className="staff-placeholder">Нет заявок на рассмотрении.</p> : registrations.map((item) => (
              <div className="moderation-row" key={item.id}>
                <span><strong>{item.legalName}</strong></span>
                <span><strong>{item.contactName}</strong><small>{item.email}</small></span>
                <span>{item.inn}</span>
                <span className="moderation-actions">
                  <select aria-label="Ценовая группа" value={groupChoice[item.id] ?? ''} onChange={(event) => setGroupChoice((prev) => ({ ...prev, [item.id]: event.target.value }))}>
                    <option value="">— группа —</option>
                    {priceGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                  </select>
                  <button type="button" disabled={busyId === item.id} aria-label={'Одобрить ' + item.legalName} onClick={() => moderate(item.id, 'approve')}><Check /> Одобрить</button>
                  <button type="button" disabled={busyId === item.id} aria-label={'Отклонить ' + item.legalName} onClick={() => moderate(item.id, 'reject')}><X /> Отклонить</button>
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {section === 'Товары' ? <CatalogAdminPanel /> : null}

        {section === 'Интеграции' ? <IntegrationsPanel /> : null}

        {section === 'Ценовые группы' || section === 'Склады' || section === 'Клиенты' ? <CommercePanel /> : null}

        {section === 'Контент' ? <ContentPanel /> : null}

        {section === 'Промо' ? <PromoPanel /> : null}

        {section === 'Лицензия' ? <LicensePanel /> : null}

        {section === 'Настройки' ? <SettingsPanel /> : null}
      </section>
    </main>
  )
}
