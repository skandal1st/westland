'use client'

import { Banknote, CreditCard, Filter, Plus, SlidersHorizontal } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { fulfillmentChannels, type PaymentMethod } from '@/lib/commerce'
import { useCommerceStore } from '@/store/commerce-store'

type CatalogItem = {
  productId: string
  slug: string
  displayName: string
  description: string
  sku: string | null
  packaging: string | null
}

export function CatalogClient() {
  const [items, setItems] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const deferredQuery = useDeferredValue(query)
  const paymentMethod = useCommerceStore((state) => state.paymentMethod)
  const setPaymentMethod = useCommerceStore((state) => state.setPaymentMethod)

  useEffect(() => {
    let active = true
    setLoading(true)
    fetch('/api/catalog')
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((data) => { if (active) setItems(data.items ?? []) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const visible = useMemo(() => {
    const needle = deferredQuery.toLowerCase()
    return items.filter((item) => (item.displayName + ' ' + (item.sku ?? '')).toLowerCase().includes(needle))
  }, [items, deferredQuery])

  const channel = fulfillmentChannels[paymentMethod]

  return (
    <main className="catalog-page">
      <section className="catalog-banner" style={{ background: '#25242a', color: '#fff' }} aria-label="Баннер каталога">
        <div><strong>Каталог</strong><span>Управляемый баннер появится в разделе промо (M9)</span></div>
      </section>
      <section className="fulfillment-choice" aria-labelledby="payment-choice-title">
        <div><strong id="payment-choice-title">Способ оплаты</strong><span>Ассортимент и остатки по каналам подключаются в M5</span></div>
        <div className="fulfillment-options" role="radiogroup" aria-label="Способ оплаты и склад">
          <button type="button" role="radio" aria-checked={paymentMethod === 'BANK_TRANSFER'} className={paymentMethod === 'BANK_TRANSFER' ? 'selected' : ''} onClick={() => setPaymentMethod('BANK_TRANSFER')}><CreditCard /><span><b>Безналичная</b><small>Счёт на оплату</small></span></button>
          <button type="button" role="radio" aria-checked={paymentMethod === 'CASH'} className={paymentMethod === 'CASH' ? 'selected' : ''} onClick={() => setPaymentMethod('CASH')}><Banknote /><span><b>Наличная</b><small>Оплата при получении</small></span></button>
        </div>
        <p>Выбранный канал: <strong>{channel.warehouseName}</strong>.</p>
      </section>
      <div className="catalog-heading">
        <div><h1>Каталог</h1><p>Позиции собираются из канонической карточки и коммерческого контента.</p></div>
        <button className="filter-toggle" onClick={() => setFiltersOpen((value) => !value)}><SlidersHorizontal /> Фильтры</button>
      </div>
      <div className="catalog-layout">
        <aside className={'filters ' + (filtersOpen ? 'open' : '')}>
          <div className="filter-title"><strong>Поиск</strong><Filter /></div>
          <label className="catalog-query">По названию или артикулу<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Название или SKU" /></label>
          <p className="filter-note">Категории, бренды и фасовки станут фильтрами после импорта каталога (M4) и промо-контента (M9).</p>
        </aside>
        <section className="products-region">
          <div className="catalog-toolbar"><span>Найдено: {visible.length}</span></div>
          <div className="product-list">
            {loading ? <div className="product-list-hint">Загрузка каталога…</div> : null}
            {!loading && visible.length === 0 ? (
              <div className="product-list-hint">Каталог пока пуст — товары появятся после импорта из учётной системы (M4).</div>
            ) : null}
            {visible.map((item) => (
              <article className="product-row" key={item.productId}>
                <div className="product-row-info">
                  {item.sku ? <span className="product-brand"><i aria-hidden="true" />{item.sku}</span> : null}
                  <h2>{item.displayName}</h2>
                  <p>{item.packaging || item.description || 'Описание дополняется сотрудником'}</p>
                </div>
                <div className="product-row-actions">
                  <div className="quantity quantity-large">
                    <button type="button" aria-label={'Добавить ' + item.displayName} disabled title="Цены и остатки подключаются в M5–M6"><Plus /></button>
                  </div>
                </div>
                <strong className="product-price">—</strong>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  )
}
