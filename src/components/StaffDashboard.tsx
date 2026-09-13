'use client'

import NextImage from 'next/image'
import { Banknote, Boxes, Building2, Check, ChevronRight, CircleUserRound, ClipboardList, Image as ImageIcon, PackageCheck, Settings, ShoppingBag, Users, X } from 'lucide-react'
import { useState } from 'react'

const orders = [
  ['WS-1048', 'ООО «Партнёр Запад»', '06.09.2026, 16:42', '48 230 ₽', 'Новый'],
  ['WS-1047', 'ООО «Точка»', '06.09.2026, 15:18', '21 870 ₽', 'Подтверждён'],
  ['WS-1046', 'ИП Демо', '06.09.2026, 12:09', '73 510 ₽', 'В работе'],
]

const initialRegistrations = [
  { id: 'u1', company: 'ООО «Новый партнёр»', inn: '7800000000', contact: 'Алексей Смирнов', email: 'demo-1@example.ru', status: 'На проверке' },
  { id: 'u2', company: 'ООО «Север»', inn: '7811000000', contact: 'Мария Волкова', email: 'demo-2@example.ru', status: 'На проверке' },
]

const banners = [
  ['Общий каталог', 'Все бренды', 'Активен'],
  ['Black Burn', 'Black Burn', 'Активен'],
  ['Bonche', 'Bonche', 'Черновик'],
]

export function StaffDashboard() {
  const [section, setSection] = useState('Заказы')
  const [registrations, setRegistrations] = useState(initialRegistrations)
  const navigation = [
    ['Заказы', ClipboardList], ['Модерация', Users], ['Товары', Boxes], ['Клиенты', Building2],
    ['Ценовые группы', ShoppingBag], ['Баннеры', ImageIcon], ['Склады', Banknote], ['Интеграции', PackageCheck], ['Настройки', Settings],
  ] as const
  const pendingCount = registrations.filter((item) => item.status === 'На проверке').length
  const actionLabel = section === 'Товары' ? 'Добавить товар' : section === 'Заказы' ? 'Создать заказ' : section === 'Баннеры' ? 'Добавить баннер' : ''

  const moderate = (id: string, status: 'Одобрен' | 'Отклонён') => {
    setRegistrations((items) => items.map((item) => item.id === id ? { ...item, status } : item))
  }

  return (
    <main className="staff-shell">
      <aside className="staff-nav"><div className="staff-brand"><NextImage src="/brand/westside-logo.png" alt="Westside" width={88} height={88} priority /><span>Back office</span></div>{navigation.map(([label, Icon]) => <button key={label} className={section === label ? 'active' : ''} onClick={() => setSection(label)}><Icon />{label}{label === 'Модерация' && pendingCount > 0 ? <b>{pendingCount}</b> : null}</button>)}<div className="staff-user"><CircleUserRound /><span>Администратор<small>admin@westside.ru</small></span></div></aside>
      <section className="staff-content">
        <header><div><h1>{section}</h1><p>Демонстрационный интерфейс первого этапа</p></div>{actionLabel ? <button className="button button-primary">{actionLabel}</button> : null}</header>

        {section === 'Заказы' ? <><div className="summary-strip"><div><span>Новые</span><strong>8</strong></div><div><span>В работе</span><strong>14</strong></div><div><span>Сегодня</span><strong>126 480 ₽</strong></div></div><div className="staff-table"><div className="table-head"><span>Заказ</span><span>Покупатель</span><span>Создан</span><span>Сумма</span><span>Статус</span><span /></div>{orders.map((order) => <button className="table-row" key={order[0]}>{order.map((cell, index) => <span key={cell} className={index === 4 ? 'status' : ''}>{cell}</span>)}<ChevronRight /></button>)}</div></> : null}

        {section === 'Модерация' ? <div className="moderation-list"><div className="moderation-head"><span>Компания</span><span>Контакт</span><span>Статус</span><span>Решение</span></div>{registrations.map((item) => <div className="moderation-row" key={item.id}><span><strong>{item.company}</strong><small>ИНН {item.inn}</small></span><span><strong>{item.contact}</strong><small>{item.email}</small></span><b className={'moderation-status ' + (item.status === 'Одобрен' ? 'approved' : item.status === 'Отклонён' ? 'rejected' : '')}>{item.status}</b><span className="moderation-actions">{item.status === 'На проверке' ? <><button type="button" aria-label={'Одобрить ' + item.company} onClick={() => moderate(item.id, 'Одобрен')}><Check /> Одобрить</button><button type="button" aria-label={'Отклонить ' + item.company} onClick={() => moderate(item.id, 'Отклонён')}><X /> Отклонить</button></> : 'Решение сохранено'}</span></div>)}</div> : null}

        {section === 'Баннеры' ? <div className="banner-admin-list"><div><strong>Баннер</strong><strong>Показывается для</strong><strong>Статус</strong></div>{banners.map((banner) => <button type="button" key={banner[0]}><span className="banner-admin-preview"><ImageIcon /></span><span><strong>{banner[0]}</strong><small>Desktop и mobile изображения</small></span><span>{banner[1]}</span><b>{banner[2]}</b><ChevronRight /></button>)}</div> : null}

        {section !== 'Заказы' && section !== 'Модерация' && section !== 'Баннеры' ? <div className="staff-placeholder"><h2>{section}</h2><p>{section === 'Товары' ? 'Сотрудники дополняют импортированные позиции: изображения, фасовка, описание, бренд и цены.' : section === 'Клиенты' ? 'Здесь видны подтверждённые компании, их пользователи и точки доставки.' : section === 'Склады' ? 'Каналы наличной и безналичной оплаты связаны со своими складами, ассортиментом и остатками.' : section === 'Интеграции' ? 'Подключения 1С, МойСклад и других провайдеров работают через единый контракт.' : 'Раздел подготовлен в архитектуре и будет подключён к базе данных на следующем этапе.'}</p></div> : null}
      </section>
    </main>
  )
}
