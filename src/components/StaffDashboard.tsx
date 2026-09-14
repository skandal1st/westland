'use client'

import NextImage from 'next/image'
import { Banknote, Boxes, Building2, Check, ChevronRight, CircleUserRound, ClipboardList, Image as ImageIcon, PackageCheck, Settings, ShoppingBag, Users, X } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'
import { useCallback, useEffect, useState } from 'react'
import { CatalogAdminPanel } from '@/components/CatalogAdminPanel'
import { useStoreProfile } from '@/lib/store-profile-context'

// Orders/banners remain demonstrative until their milestones (M7/M9).
const orders = [
  ['WS-1048', 'ООО «Партнёр Запад»', '06.09.2026, 16:42', '48 230 ₽', 'Новый'],
  ['WS-1047', 'ООО «Точка»', '06.09.2026, 15:18', '21 870 ₽', 'Подтверждён'],
  ['WS-1046', 'ИП Демо', '06.09.2026, 12:09', '73 510 ₽', 'В работе'],
]
const banners = [
  ['Общий каталог', 'Все бренды', 'Активен'],
  ['Black Burn', 'Black Burn', 'Активен'],
  ['Bonche', 'Bonche', 'Черновик'],
]

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
  }, [loadPending])

  const moderate = async (id: string, action: 'approve' | 'reject') => {
    setBusyId(id)
    try {
      const body = action === 'reject' ? JSON.stringify({ comment: 'Отклонено сотрудником' }) : undefined
      const response = await fetch(`/api/staff/registrations/${id}/${action}`, {
        method: 'POST',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body,
      })
      if (response.ok) await loadPending()
    } finally {
      setBusyId(null)
    }
  }

  const navigation = [
    ['Заказы', ClipboardList], ['Модерация', Users], ['Товары', Boxes], ['Клиенты', Building2],
    ['Ценовые группы', ShoppingBag], ['Баннеры', ImageIcon], ['Склады', Banknote], ['Интеграции', PackageCheck], ['Настройки', Settings],
  ] as const
  const pendingCount = registrations.length
  const actionLabel = section === 'Товары' ? 'Добавить товар' : section === 'Заказы' ? 'Создать заказ' : section === 'Баннеры' ? 'Добавить баннер' : ''

  return (
    <main className="staff-shell">
      <aside className="staff-nav">
        <div className="staff-brand"><NextImage src="/brand/westside-logo.png" alt={profile.identity.name} width={88} height={88} priority /><span>Back office</span></div>
        {navigation.map(([label, Icon]) => <button key={label} className={section === label ? 'active' : ''} onClick={() => setSection(label)}><Icon />{label}{label === 'Модерация' && pendingCount > 0 ? <b>{pendingCount}</b> : null}</button>)}
        <div className="staff-user"><CircleUserRound /><span>{session?.user?.name ?? 'Сотрудник'}<small>{session?.user?.email ?? ''}</small></span><button type="button" className="staff-signout" onClick={() => signOut({ callbackUrl: '/login' })}>Выйти</button></div>
      </aside>
      <section className="staff-content">
        <header><div><h1>{section}</h1><p>{profile.identity.name} · back office</p></div>{actionLabel ? <button className="button button-primary">{actionLabel}</button> : null}</header>

        {section === 'Заказы' ? <><div className="summary-strip"><div><span>Новые</span><strong>8</strong></div><div><span>В работе</span><strong>14</strong></div><div><span>Сегодня</span><strong>126 480 ₽</strong></div></div><div className="staff-table"><div className="table-head"><span>Заказ</span><span>Покупатель</span><span>Создан</span><span>Сумма</span><span>Статус</span><span /></div>{orders.map((order) => <button className="table-row" key={order[0]}>{order.map((cell, index) => <span key={cell} className={index === 4 ? 'status' : ''}>{cell}</span>)}<ChevronRight /></button>)}</div></> : null}

        {section === 'Модерация' ? (
          <div className="moderation-list">
            <div className="moderation-head"><span>Компания</span><span>Контакт</span><span>ИНН</span><span>Решение</span></div>
            {registrations.length === 0 ? <p className="staff-placeholder">Нет заявок на рассмотрении.</p> : registrations.map((item) => (
              <div className="moderation-row" key={item.id}>
                <span><strong>{item.legalName}</strong></span>
                <span><strong>{item.contactName}</strong><small>{item.email}</small></span>
                <span>{item.inn}</span>
                <span className="moderation-actions">
                  <button type="button" disabled={busyId === item.id} aria-label={'Одобрить ' + item.legalName} onClick={() => moderate(item.id, 'approve')}><Check /> Одобрить</button>
                  <button type="button" disabled={busyId === item.id} aria-label={'Отклонить ' + item.legalName} onClick={() => moderate(item.id, 'reject')}><X /> Отклонить</button>
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {section === 'Товары' ? <CatalogAdminPanel /> : null}

        {section === 'Баннеры' ? <div className="banner-admin-list"><div><strong>Баннер</strong><strong>Показывается для</strong><strong>Статус</strong></div>{banners.map((banner) => <button type="button" key={banner[0]}><span className="banner-admin-preview"><ImageIcon /></span><span><strong>{banner[0]}</strong><small>Desktop и mobile изображения</small></span><span>{banner[1]}</span><b>{banner[2]}</b><ChevronRight /></button>)}</div> : null}

        {section !== 'Заказы' && section !== 'Модерация' && section !== 'Баннеры' && section !== 'Товары' ? <div className="staff-placeholder"><h2>{section}</h2><p>{section === 'Клиенты' ? 'Здесь видны подтверждённые компании, их пользователи и точки доставки.' : section === 'Склады' ? 'Каналы наличной и безналичной оплаты связаны со своими складами, ассортиментом и остатками.' : section === 'Интеграции' ? 'Подключения 1С, МойСклад и других провайдеров работают через единый контракт.' : 'Раздел подготовлен в архитектуре и будет подключён к базе данных на следующем этапе.'}</p></div> : null}
      </section>
    </main>
  )
}
