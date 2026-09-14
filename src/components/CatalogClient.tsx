'use client'

import { Banknote, CreditCard, Filter, Minus, Plus, SlidersHorizontal } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useCart } from '@/lib/cart/cart-context'

type Channel = { id: string; code: string; name: string; paymentMethod: 'BANK_TRANSFER' | 'CASH' }

type CatalogItem = {
  productId: string
  variantId: string | null
  slug: string
  displayName: string
  description: string
  sku: string | null
  packaging: string | null
  price: { amount: number; currency: string } | null
  availability: { available: number; stale: boolean } | null
}

export function CatalogClient() {
  const { view, setChannel, setItem, quantityOf } = useCart()
  const [channels, setChannels] = useState<Channel[]>([])
  const [items, setItems] = useState<CatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const deferredQuery = useDeferredValue(query)
  const channelId = view.channelId

  useEffect(() => {
    fetch('/api/channels')
      .then((r) => (r.ok ? r.json() : { channels: [] }))
      .then((data) => {
        setChannels(data.channels ?? [])
        if (!view.channelId && data.channels?.[0]) setChannel(data.channels[0].id)
      })
  }, [view.channelId, setChannel])

  useEffect(() => {
    let active = true
    setLoading(true)
    const url = channelId ? `/api/catalog?channel=${encodeURIComponent(channelId)}` : '/api/catalog'
    fetch(url)
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((data) => { if (active) setItems(data.items ?? []) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [channelId])

  const visible = useMemo(() => {
    const needle = deferredQuery.toLowerCase()
    return items.filter((item) => (item.displayName + ' ' + (item.sku ?? '')).toLowerCase().includes(needle))
  }, [items, deferredQuery])

  const activeChannel = channels.find((c) => c.id === channelId)

  return (
    <main className="catalog-page">
      <section className="catalog-banner" style={{ background: '#25242a', color: '#fff' }} aria-label="Баннер каталога">
        <div><strong>Каталог</strong><span>Управляемый баннер появится в разделе промо (M9)</span></div>
      </section>
      <section className="fulfillment-choice" aria-labelledby="payment-choice-title">
        <div><strong id="payment-choice-title">Канал получения</strong><span>Цена и остатки зависят от выбранного канала</span></div>
        <div className="fulfillment-options" role="radiogroup" aria-label="Канал получения и оплаты">
          {channels.length === 0 ? <small>Каналы не настроены — обратитесь к менеджеру.</small> : channels.map((channel) => (
            <button key={channel.id} type="button" role="radio" aria-checked={channelId === channel.id} className={channelId === channel.id ? 'selected' : ''} onClick={() => setChannel(channel.id)}>
              {channel.paymentMethod === 'CASH' ? <Banknote /> : <CreditCard />}
              <span><b>{channel.name}</b><small>{channel.paymentMethod === 'CASH' ? 'Наличный расчёт' : 'Безналичный расчёт'}</small></span>
            </button>
          ))}
        </div>
        {activeChannel ? <p>Выбранный канал: <strong>{activeChannel.name}</strong>. При смене канала цена и остатки пересчитываются.</p> : null}
      </section>
      <div className="catalog-heading">
        <div><h1>Каталог</h1><p>Цена — по вашей ценовой группе; остаток — проекция выбранного канала.</p></div>
        <button className="filter-toggle" onClick={() => setFiltersOpen((value) => !value)}><SlidersHorizontal /> Фильтры</button>
      </div>
      <div className="catalog-layout">
        <aside className={'filters ' + (filtersOpen ? 'open' : '')}>
          <div className="filter-title"><strong>Поиск</strong><Filter /></div>
          <label className="catalog-query">По названию или артикулу<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Название или SKU" /></label>
          <p className="filter-note">Категории и бренды станут фильтрами вместе с промо-контентом (M9).</p>
        </aside>
        <section className="products-region">
          <div className="catalog-toolbar"><span>Найдено: {visible.length}</span></div>
          <div className="product-list">
            {loading ? <div className="product-list-hint">Загрузка каталога…</div> : null}
            {!loading && visible.length === 0 ? <div className="product-list-hint">Каталог пуст — товары появятся после импорта из учётной системы.</div> : null}
            {visible.map((item) => {
              const quantity = item.variantId ? quantityOf(item.variantId) : 0
              const available = item.availability?.available ?? null
              const canAdd = Boolean(item.variantId && item.price && (available == null || quantity < available))
              return (
                <article className={'product-row ' + (quantity > 0 ? 'in-cart' : '')} key={item.productId}>
                  <div className="product-row-info">
                    {item.sku ? <span className="product-brand"><i aria-hidden="true" />{item.sku}</span> : null}
                    <h2>{item.displayName}</h2>
                    <p>{item.packaging ? item.packaging + ' · ' : ''}{available != null ? `${available} шт.${item.availability?.stale ? ' (устаревает)' : ''}` : 'остаток уточняется'}</p>
                  </div>
                  <div className="product-row-actions">
                    <div className="quantity quantity-large">
                      <button type="button" aria-label={'Уменьшить ' + item.displayName} disabled={quantity === 0} onClick={() => item.variantId && setItem(item.variantId, quantity - 1)}><Minus /></button>
                      <span>{quantity}</span>
                      <button type="button" aria-label={'Добавить ' + item.displayName} disabled={!canAdd} title={!item.price ? 'Нет цены для вашей группы' : undefined} onClick={() => item.variantId && setItem(item.variantId, quantity + 1)}><Plus /></button>
                    </div>
                  </div>
                  <strong className="product-price">{item.price ? `${item.price.amount.toLocaleString('ru-RU')} ${item.price.currency === 'RUB' ? '₽' : item.price.currency}` : '—'}</strong>
                </article>
              )
            })}
          </div>
        </section>
      </div>
    </main>
  )
}
