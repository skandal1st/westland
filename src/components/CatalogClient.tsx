'use client'

import { formatMoney as formatDecimalMoney } from '@/lib/money-format'

import { Banknote, CreditCard, Filter, Minus, Plus, SlidersHorizontal } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { readArray, useRemoteResource } from '@/lib/use-remote-resource'
import { useCallback, useEffect, useState, useTransition, type FormEvent } from 'react'
import { useCart } from '@/lib/cart/cart-context'
import { CategoryTreeControl } from './CategoryTreeControl'
import type { CategoryNode } from '@/lib/catalog/tree'
import { StoreBanners, type StorefrontBanner } from './StoreBanners'

type Channel = { id: string; code: string; name: string; paymentMethod: 'BANK_TRANSFER' | 'CASH' }

type CatalogItem = {
  productId: string
  variantId: string | null
  slug: string
  displayName: string
  description: string
  attributes: { name: string; value: string }[]
  sku: string | null
  sourceSku?: string | null
  packaging: string | null
  price: { amount: number; amountExact: string; currency: string; listAmount?: number; listAmountExact?: string; promotionIds?: string[] } | null
  availability: { available: number; stale: boolean } | null
}


function formatMoney(amount: string, currency: string): string {
  return `${formatDecimalMoney(amount)} ${currency === 'RUB' ? '₽' : currency}`
}

const PAGE_SIZE = 50
const decodeChannels = (value: unknown) => readArray<Channel>(value, 'channels')
const decodeBanners = (value: unknown) => readArray<StorefrontBanner>(value, 'banners')
const decodeCatalog = (value: unknown) => {
  const items = readArray<CatalogItem>(value, 'items')
  const total = (value as { total?: number }).total
  if (!Number.isSafeInteger(total) || total! < 0) throw new Error('Не удалось получить количество товаров. Повторите запрос.')
  return { items, total: total! }
}

type Facet = { name: string; slug: string; count: number }
type Facets = { tree: CategoryNode[]; trail: {id:string;name:string;slug:string}[]; categories: Facet[]; brands: Facet[]; category: {name:string;slug:string}|null; brand: {name:string;slug:string}|null }
const decodeFacets = (value: unknown) => value as Facets
export function CatalogClient({ fixedBrand }: { fixedBrand?: { name: string; slug: string } } = {}) {
  const { view, ready, loadError: cartError, changeError, retryChange, updating, refresh: refreshCart, setChannel, setItem, quantityOf } = useCart()
  const router = useRouter()
  const [filterPending, startFilterTransition] = useTransition()
  const searchParams = useSearchParams()
  const search = searchParams.get('q') ?? ''
  const [query, setQuery] = useState(search)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [changingChannel, setChangingChannel] = useState(false)
  const channelId = view.channelId
  const categorySlug = searchParams.get('category') ?? ''
  const brandSlug = fixedBrand?.slug ?? searchParams.get('brand') ?? ''
  const basePath = fixedBrand ? '/brands/' + encodeURIComponent(fixedBrand.slug) : '/catalog'
  const requestedPage = Number(searchParams.get('page') ?? '1')
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 42949673 ? requestedPage : 1

  useEffect(() => { setQuery(search) }, [search])

  const channelResource = useRemoteResource('/api/channels', decodeChannels)
  const bannerResource = useRemoteResource('/api/content?placement=CATALOG' + (categorySlug ? '&category='+encodeURIComponent(categorySlug) : '') + (brandSlug ? '&brand='+encodeURIComponent(brandSlug) : ''), decodeBanners)
  const channels = channelResource.data ?? []
  const banners = bannerResource.data ?? []
  const params = new URLSearchParams({ take: String(PAGE_SIZE), skip: String((page - 1) * PAGE_SIZE) })
  if (channelId) params.set('channel', channelId)
  if (categorySlug) params.set('category', categorySlug)
  if (brandSlug) params.set('brand', brandSlug)
  if (search) params.set('q', search)
  const catalog = useRemoteResource('/api/catalog?' + params.toString(), decodeCatalog)
  const facetParams = new URLSearchParams()
  if(categorySlug)facetParams.set('category',categorySlug)
  if(brandSlug)facetParams.set('brand',brandSlug)
  if(search)facetParams.set('q',search)
  const facets = useRemoteResource('/api/catalog/facets?' + facetParams.toString(), decodeFacets)
  const changeFilter = (kind: 'category'|'brand', value: string) => {
    const next = new URLSearchParams(searchParams.toString());next.delete('page')
    if(value)next.set(kind,value);else next.delete(kind)
    if(kind==='category'&&!fixedBrand)next.delete('brand')
    startFilterTransition(() => router.push(basePath+(next.size?'?'+next.toString():''),{scroll:false}))
  }
  const title = fixedBrand?.name ?? facets.data?.category?.name ?? facets.data?.brand?.name ?? 'Каталог'
  const loading = catalog.loading || changingChannel
  const items = !loading && !catalog.error ? catalog.data?.items ?? [] : []
  const total = catalog.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const chooseChannel = useCallback(async (id: string) => {
    setChangingChannel(true)
    try { await setChannel(id) }
    finally { setChangingChannel(false) }
  }, [setChannel])

  // Wait for the saved cart before choosing a default, so refresh preserves its channel.
  useEffect(() => {
    if (ready && !channelId && channelResource.data?.[0]) void chooseChannel(channelResource.data[0].id)
  }, [ready, channelId, channelResource.data, chooseChannel])

  const pageHref = (target: number) => {
    const next = new URLSearchParams(searchParams.toString())
    if (target === 1) next.delete('page')
    else next.set('page', String(target))
    return basePath + (next.size ? '?' + next.toString() : '')
  }
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const next = new URLSearchParams(searchParams.toString())
    next.delete('page')
    if (query.trim()) next.set('q', query.trim())
    else next.delete('q')
    router.push(basePath + (next.size ? '?' + next.toString() : ''), { scroll: false })
  }
  const activeChannel = channels.find((c) => c.id === channelId)

  return (
    <main className="catalog-page">
      {banners.length > 0 ? <StoreBanners banners={banners} /> : <section className="catalog-banner" style={{ background: '#25242a', color: '#fff' }} aria-label="Баннер каталога"><div><strong>{fixedBrand?.name ?? 'Каталог'}</strong><span>Оптовый ассортимент для партнёров</span></div></section>}
      {bannerResource.loading ? <p role="status">Загрузка баннеров…</p> : bannerResource.error ? <div className="load-error" role="alert"><span>Баннеры недоступны. {bannerResource.error}</span><button type="button" onClick={bannerResource.reload}>Повторить загрузку баннеров</button></div> : null}
      <section className="fulfillment-choice" aria-labelledby="payment-choice-title">
        <div><strong id="payment-choice-title">Канал получения</strong><span>Цена и остатки зависят от выбранного канала</span></div>
        <div className="fulfillment-options" role="radiogroup" aria-label="Канал получения и оплаты">
          {channelResource.loading ? <small role="status">Загрузка каналов…</small> : channelResource.error ? <div className="load-error" role="alert"><span>{channelResource.error}</span><button type="button" onClick={channelResource.reload}>Повторить загрузку каналов</button></div> : channels.length === 0 ? <small>Каналы не настроены — обратитесь к менеджеру.</small> : channels.map((channel) => (
            <button key={channel.id} type="button" role="radio" aria-checked={channelId === channel.id} className={channelId === channel.id ? 'selected' : ''} disabled={updating || changingChannel || !ready} onClick={() => chooseChannel(channel.id)}>
              {channel.paymentMethod === 'CASH' ? <Banknote /> : <CreditCard />}
              <span><b>{channel.name}</b><small>{channel.paymentMethod === 'CASH' ? 'Наличный расчёт' : 'Безналичный расчёт'}</small></span>
            </button>
          ))}
        </div>
        {cartError ? <div className="load-error" role="alert"><span>{cartError}</span><button type="button" onClick={refreshCart}>Повторить загрузку корзины</button></div> : !ready ? <p role="status">Загрузка выбранного канала и корзины…</p> : null}
        {changeError ? <div className="load-error" role="alert"><span>{changeError}</span><button type="button" disabled={updating} onClick={retryChange}>Повторить изменение корзины</button><button type="button" onClick={refreshCart}>Обновить корзину</button></div> : null}
        {activeChannel ? <p>Выбранный канал: <strong>{activeChannel.name}</strong>. При смене канала цена и остатки пересчитываются.</p> : null}
      </section>
      <div className="catalog-heading">
        <div><h1>{title}</h1><p>Заявка не резервирует товар. Наличие, состав и сумму подтвердит 1С.</p></div>
        <button className="filter-toggle" onClick={() => setFiltersOpen((value) => !value)}><SlidersHorizontal /> Фильтры</button>
      </div>
      <div className="catalog-layout">
        <aside className={'filters ' + (filtersOpen ? 'open' : '')}>
          <div className="filter-title"><strong>Поиск</strong><Filter /></div>
          <form onSubmit={submitSearch} role="search">
            <label className="catalog-query">По названию или артикулу<input type="search" maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Название или артикул" /></label>
            <button type="submit" className="button button-secondary">Найти</button>
          </form>
          {facets.loading ? <p role="status">Загрузка фильтров…</p> : null}
          {facets.error ? <div className="load-error" role="alert">{facets.error}<button onClick={facets.reload}>Повторить</button></div> : null}
          <div className="catalog-facet-group"><h2>Категории</h2><button className={!categorySlug?'selected':''} aria-pressed={!categorySlug} disabled={filterPending} onClick={()=>changeFilter('category','')}>Все категории</button><CategoryTreeControl nodes={facets.data?.tree??[]} selectedId={facets.data?.trail?.at(-1)?.id} disabled={filterPending} onSelect={node=>changeFilter('category',node.slug??'')}/></div>
          </aside>
        <section className="products-region" aria-busy={loading}>
            {!!facets.data?.trail?.length?<nav className="catalog-breadcrumbs" aria-label="Путь категории"><Link href={basePath}>Каталог</Link>{facets.data.trail.map(n=><Link key={n.id} href={basePath+'?category='+encodeURIComponent(n.slug)}>{n.name}</Link>)}</nav>:null}
          <div className="catalog-toolbar"><span role="status">{loading ? 'Загрузка товаров…' : catalog.error ? 'Каталог недоступен' : `Найдено: ${total}`}</span>{(search || categorySlug || brandSlug) ? <Link className="catalog-reset" href={basePath}>Сбросить фильтры</Link> : null}</div>
          {catalog.error ? <div className="load-error" role="alert"><span>{catalog.error}</span><button type="button" onClick={catalog.reload}>Повторить загрузку каталога</button></div> : null}
          <div className="product-list">
            {loading ? <div className="product-list-hint">Загрузка каталога…</div> : null}
            {!loading && !catalog.error && items.length === 0 ? <div className="product-list-hint" role="status">{total > 0 ? <>На этой странице товаров нет. <Link href={pageHref(1)}>На первую страницу</Link></> : search || categorySlug || brandSlug ? 'По вашему запросу товары не найдены. Измените поиск или сбросьте фильтры.' : 'Каталог пуст — товары появятся после импорта из учётной системы.'}</div> : null}
            {items.map((item) => {
              const quantity = item.variantId ? quantityOf(item.variantId) : 0
              const available = item.availability?.available ?? null
              const canAdd = Boolean(ready && !updating && activeChannel && !channelResource.loading && !channelResource.error && item.variantId && item.price && quantity < 100000)
              return (
                <article className={'product-row ' + (quantity > 0 ? 'in-cart' : '')} key={item.productId}>
                  <div className="product-row-info">
                    {(item.sourceSku ?? item.sku) ? <span className="product-brand"><i aria-hidden="true" />{item.sourceSku ?? item.sku}</span> : null}
                    <h2>{item.displayName}</h2>
                    <p>{item.packaging ? item.packaging + ' · ' : ''}{available != null ? `Последние данные: ${available} шт.${item.availability?.stale ? ' (данные устарели)' : ''}. Наличие уточняется` : 'остаток уточняется'}</p>
                    {item.description || item.attributes.length ? <details className="product-extra"><summary>Подробнее</summary>{item.description ? <p>{item.description}</p> : null}{item.attributes.length ? <dl>{item.attributes.map(attribute => <div key={attribute.name}><dt>{attribute.name}</dt><dd>{attribute.value}</dd></div>)}</dl> : null}</details> : null}
                  </div>
                  <div className="product-row-actions">
                    <div className="quantity quantity-large">
                      <button type="button" aria-label={'Уменьшить ' + item.displayName} disabled={updating || quantity === 0} onClick={() => item.variantId && setItem(item.variantId, quantity - 1)}><Minus /></button>
                      <span>{quantity}</span>
                      <button type="button" aria-label={'Добавить ' + item.displayName} disabled={!canAdd} title={!item.price ? 'Нет цены для вашей группы' : undefined} onClick={() => item.variantId && setItem(item.variantId, quantity + 1)}><Plus /></button>
                    </div>
                  </div>
                  <strong className="product-price">
                    {item.price ? (
                      item.price.listAmountExact && item.price.listAmountExact !== item.price.amountExact ? (
                        <>
                          <s style={{ opacity: 0.55, fontWeight: 400, marginRight: 8 }}>{formatMoney(item.price.listAmountExact, item.price.currency)}</s>
                          {formatMoney(item.price.amountExact, item.price.currency)}
                        </>
                      ) : (
                        formatMoney(item.price.amountExact, item.price.currency)
                      )
                    ) : '—'}
                  </strong>
                </article>
              )
            })}
          </div>
          {!loading && !catalog.error && total > 0 ? <nav className="catalog-pagination" aria-label="Страницы каталога">
            {page > 1 ? <Link className="button button-secondary" href={pageHref(page - 1)} scroll={false}>Назад</Link> : <button className="button button-secondary" disabled>Назад</button>}
            <span>Страница {page} из {pages}</span>
            {page < pages ? <Link className="button button-secondary" href={pageHref(page + 1)} scroll={false}>Далее</Link> : <button className="button button-secondary" disabled>Далее</button>}
          </nav> : null}
        </section>
      </div>
    </main>
  )
}
