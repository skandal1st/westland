'use client'

import NextImage from 'next/image'
import { Banknote, BookOpenText, Boxes, Building2, Check, CircleUserRound, ClipboardList, Image as ImageIcon, PackageCheck, Settings, ShieldCheck, ShoppingBag, Tag, UserRoundCog, Users, X } from 'lucide-react'
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
import { OnecExchangeStatus } from '@/components/OnecExchangeStatus'
import { OnecWarehousesPanel } from '@/components/OnecWarehousesPanel'
import { OnecBrandGroupsPanel } from '@/components/OnecBrandGroupsPanel'
import { BrandLogosPanel } from '@/components/BrandLogosPanel'
import { CategoriesPanel } from '@/components/CategoriesPanel'
import { StaffAccountsPanel } from '@/components/StaffAccountsPanel'
import { StaffGuide } from '@/components/StaffGuide'
import { useStoreProfile } from '@/lib/store-profile-context'

type PendingRequest = {
  id: string
  email: string
  contactName: string
  legalName: string
  inn: string
  deliveryLocations: Array<{ id: string; name: string; city: string; address: string }>
}

export function StaffDashboard() {
  const { data: session } = useSession()
  const profile = useStoreProfile()
  const [section, setSection] = useState('Модерация')
  const [catalogTab, setCatalogTab] = useState<'Товары' | 'Категории' | 'Бренды'>('Товары')
  const [registrations, setRegistrations] = useState<PendingRequest[]>([])
  const [priceGroups, setPriceGroups] = useState<{ id: string; name: string }[]>([])
  const [groupChoice, setGroupChoice] = useState<Record<string, string>>({})
  const [pointChoice, setPointChoice] = useState<Record<string, string[]>>({})
  const [moderationError, setModerationError] = useState<string | null>(null)
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
    setModerationError(null)
    try {
      const payload = action === 'reject' ? { comment: 'Отклонено сотрудником' } : { priceGroupId: groupChoice[id] || undefined, locationIds: pointChoice[id] ?? [] }
      const response = await fetch(`/api/staff/registrations/${id}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (response.ok) await loadPending()
      else setModerationError('Не удалось сохранить решение. Проверьте реквизиты и выбранные точки, затем обновите список.')
    } catch {
      setModerationError('Не удалось связаться с сервером. Повторите попытку.')
    } finally {
      setBusyId(null)
    }
  }

  const navigation = [
    ['Заказы', ClipboardList], ['Модерация', Users], ['Каталог', Boxes], ['Клиенты', Building2], ['Сотрудники', UserRoundCog],
    ['Ценовые группы', ShoppingBag], ['Контент', ImageIcon], ['Промотовары', Tag], ['Склады', Banknote], ['Интеграции', PackageCheck], ['Лицензия', ShieldCheck], ['Настройки', Settings], ['Инструкция', BookOpenText],
  ] as const
  const pendingCount = registrations.length

  return (
    <main className="staff-shell">
      <aside className="staff-nav">
        <div className="staff-brand"><NextImage src="/brand/westside-logo.png" alt={profile.identity.name} width={88} height={88} priority /><span>Панель управления</span></div>
        {navigation.filter(([label]) => label !== 'Сотрудники' || session?.user?.role === 'ADMIN').map(([label, Icon]) => <button key={label} className={section === label ? 'active' : ''} onClick={() => setSection(label)}><Icon />{label}{label === 'Модерация' && pendingCount > 0 ? <b>{pendingCount}</b> : null}</button>)}
        <div className="staff-user"><CircleUserRound /><span>{session?.user?.name ?? 'Сотрудник'}<small>{session?.user?.email ?? ''}</small></span><button type="button" className="staff-signout" onClick={() => signOut({ callbackUrl: '/login' })}>Выйти</button></div>
      </aside>
      <section className="staff-content">
        <header><div><h1>{section}</h1><p>{profile.identity.name} · панель управления</p></div></header>

        {section === 'Заказы' ? <OrdersPanel /> : null}

        {section === 'Модерация' ? (
          <div className="moderation-list">
            {moderationError ? <p role="alert">{moderationError}</p> : null}
            <div className="moderation-head"><span>Компания</span><span>Контакт</span><span>ИНН</span><span>Решение</span></div>
            {registrations.length === 0 ? <p className="staff-placeholder">Нет заявок на рассмотрении.</p> : registrations.map((item) => (
              <div className="moderation-row" key={item.id}>
                <div><strong>{item.legalName}</strong>
                  <fieldset className="delivery-point-options" disabled={busyId === item.id}>
                    <legend>Разрешённые точки доставки</legend>
                    {(item.deliveryLocations ?? []).map(point => <label key={point.id} >
                      <input type="checkbox" checked={(pointChoice[item.id] ?? []).includes(point.id)} onChange={event => {
                        const checked = event.target.checked
                        setPointChoice(previous => ({ ...previous, [item.id]: checked ? [...(previous[item.id] ?? []), point.id] : (previous[item.id] ?? []).filter(id => id !== point.id) }))
                      }} /> {point.name} — {point.city}, {point.address}
                    </label>)}
                    {!item.deliveryLocations?.length ? <p>Точки контрагента ещё не загружены на сайт.</p> : null}
                    <small>Без выбранных точек пользователь сможет самостоятельно добавить новую.</small>
                  </fieldset>
                </div>
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

        {section === 'Каталог' ? <>
          <div className="admin-tabs" role="tablist" aria-label="Управление каталогом">
            {(['Товары', 'Категории', 'Бренды'] as const).map((tab, index) => <button key={tab} id={'catalog-tab-' + index} role="tab" aria-selected={catalogTab === tab} aria-controls="catalog-panel" tabIndex={catalogTab === tab ? 0 : -1} onKeyDown={e => {
              const tabs = ['Товары', 'Категории', 'Бренды'] as const
              const next = e.key === 'ArrowRight' ? (index + 1) % 3 : e.key === 'ArrowLeft' ? (index + 2) % 3 : e.key === 'Home' ? 0 : e.key === 'End' ? 2 : -1
              if (next >= 0) { e.preventDefault(); setCatalogTab(tabs[next]); document.getElementById('catalog-tab-' + next)?.focus() }
            }} onClick={() => setCatalogTab(tab)}>{tab}</button>)}
          </div>
          <div id="catalog-panel" role="tabpanel" aria-labelledby={'catalog-tab-' + ['Товары', 'Категории', 'Бренды'].indexOf(catalogTab)}>
            {catalogTab === 'Товары' ? <CatalogAdminPanel /> : catalogTab === 'Категории' ? <CategoriesPanel /> : <><BrandLogosPanel /><OnecBrandGroupsPanel /></>}
          </div>
        </> : null}

        {section === 'Интеграции' ? <><OnecExchangeStatus /><OnecWarehousesPanel /><IntegrationsPanel /></> : null}

        {section === 'Клиенты' ? <CommercePanel view="customers" /> : null}

        {section === 'Сотрудники' && session?.user?.role === 'ADMIN' ? <StaffAccountsPanel /> : null}

        {section === 'Ценовые группы' ? <CommercePanel view="pricing" /> : null}

        {section === 'Склады' ? <CommercePanel view="warehouses" /> : null}

        {section === 'Контент' ? <ContentPanel /> : null}

        {section === 'Промотовары' ? <PromoPanel /> : null}

        {section === 'Лицензия' ? <LicensePanel /> : null}

        {section === 'Настройки' ? <SettingsPanel /> : null}

        {section === 'Инструкция' ? <StaffGuide /> : null}
      </section>
    </main>
  )
}
