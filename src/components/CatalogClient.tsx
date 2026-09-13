'use client'

import { Banknote, ChevronDown, CreditCard, Filter, Minus, Plus, SlidersHorizontal } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { brands, categories, products } from '@/lib/demo-data'
import { brandBanners, fulfillmentChannels, type PaymentMethod } from '@/lib/commerce'
import { useCart } from '@/store/cart-store'
import { useCommerceStore } from '@/store/commerce-store'

export function CatalogClient() {
  const searchParams = useSearchParams()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('Все товары')
  const [brand, setBrand] = useState('Все бренды')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const deferredQuery = useDeferredValue(query)
  const lines = useCart((state) => state.lines)
  const add = useCart((state) => state.add)
  const decrement = useCart((state) => state.decrement)
  const clear = useCart((state) => state.clear)
  const paymentMethod = useCommerceStore((state) => state.paymentMethod)
  const setPaymentMethod = useCommerceStore((state) => state.setPaymentMethod)

  useEffect(() => {
    const requestedBrand = searchParams.get('brand')
    setBrand(requestedBrand && brands.includes(requestedBrand) ? requestedBrand : 'Все бренды')
  }, [searchParams])

  const quantityByProduct = useMemo(
    () => new Map(lines.map((line) => [line.product.id, line.quantity])),
    [lines],
  )
  const warehouseProducts = useMemo(
    () => products.filter((product) => product.stocks[paymentMethod] > 0),
    [paymentMethod],
  )
  const visible = useMemo(() => warehouseProducts.filter((product) => {
    const matchesCategory = category === 'Все товары' || product.category === category
    const matchesBrand = brand === 'Все бренды' || product.brand.toLowerCase() === brand.toLowerCase()
    const haystack = (product.brand + ' ' + product.name).toLowerCase()
    return matchesCategory && matchesBrand && haystack.includes(deferredQuery.toLowerCase())
  }), [brand, category, deferredQuery, warehouseProducts])
  const channel = fulfillmentChannels[paymentMethod]
  const banner = brandBanners[brand] ?? brandBanners.default

  const selectPaymentMethod = (method: PaymentMethod) => {
    if (method === paymentMethod) return
    clear()
    setPaymentMethod(method)
  }

  return (
    <main className="catalog-page">
      <section className="catalog-banner" key={banner.title} style={{ background: banner.tone, color: banner.ink }} aria-label={banner.description}>
        <div><strong>{banner.title}</strong><span>{banner.description}</span></div>
        <small>Демонстрационное место для управляемого изображения</small>
      </section>
      <section className="fulfillment-choice" aria-labelledby="payment-choice-title">
        <div><strong id="payment-choice-title">Способ оплаты</strong><span>Ассортимент и остатки переключаются между складами</span></div>
        <div className="fulfillment-options" role="radiogroup" aria-label="Способ оплаты и склад">
          <button type="button" role="radio" aria-checked={paymentMethod === 'BANK_TRANSFER'} className={paymentMethod === 'BANK_TRANSFER' ? 'selected' : ''} onClick={() => selectPaymentMethod('BANK_TRANSFER')}><CreditCard /><span><b>Безналичная</b><small>Счёт на оплату</small></span></button>
          <button type="button" role="radio" aria-checked={paymentMethod === 'CASH'} className={paymentMethod === 'CASH' ? 'selected' : ''} onClick={() => selectPaymentMethod('CASH')}><Banknote /><span><b>Наличная</b><small>Оплата при получении</small></span></button>
        </div>
        <p>Сейчас выбран: <strong>{channel.warehouseName}</strong>. При смене способа оплаты корзина очищается.</p>
      </section>
      <div className="catalog-heading">
        <div><h1>Каталог</h1><p>Демонстрационные товары. После подключения ERP здесь появятся реальные позиции и остатки.</p></div>
        <button className="filter-toggle" onClick={() => setFiltersOpen((value) => !value)}><SlidersHorizontal /> Фильтры</button>
      </div>
      <div className="catalog-layout">
        <aside className={'filters ' + (filtersOpen ? 'open' : '')}>
          <div className="filter-title"><strong>Категории</strong><Filter /></div>
          <button className={category === 'Все товары' ? 'selected' : ''} onClick={() => setCategory('Все товары')}><span>Все товары</span><b>{warehouseProducts.length}</b></button>
          {categories.map((item) => <button key={item.name} className={category === item.name ? 'selected' : ''} onClick={() => setCategory(item.name)}><span>{item.name}</span><b>{warehouseProducts.filter((product) => product.category === item.name).length}</b></button>)}
          <div className="filter-group"><strong>Бренды</strong><ChevronDown /></div>
          <button className={brand === 'Все бренды' ? 'selected' : ''} onClick={() => setBrand('Все бренды')}><span>Все бренды</span></button>
          {brands.map((item) => <button key={item} className={brand === item ? 'selected' : ''} onClick={() => setBrand(item)}><span>{item}</span></button>)}
          <div className="filter-group"><strong>Фасовка</strong><ChevronDown /></div>
          <label><input type="checkbox" /> 25 г</label><label><input type="checkbox" /> 30 г</label><label><input type="checkbox" /> 100 г</label>
        </aside>
        <section className="products-region">
          <div className="catalog-toolbar">
            <label className="catalog-query">Поиск в категории<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Название или бренд" /></label>
            <span>Найдено: {visible.length}</span>
            <select aria-label="Сортировка"><option>Сначала новинки</option><option>По бренду</option><option>По наличию</option></select>
          </div>
          <div className="product-list">
            <div className="product-list-hint">Нажмите «+», чтобы добавить товар в корзину</div>
            {visible.map((product) => {
              const quantity = quantityByProduct.get(product.id) ?? 0
              const stock = product.stocks[paymentMethod]
              return (
                <article className={'product-row ' + (quantity > 0 ? 'in-cart' : '')} key={product.id}>
                  <div className="product-row-info">
                    <span className="product-brand"><i aria-hidden="true" />{product.brand}</span>
                    <h2>{product.name}</h2>
                    <p>{product.packaging} · {stock} шт. на складе</p>
                  </div>
                  <div className="product-row-actions">
                    <div className="quantity quantity-large">
                      <button type="button" aria-label={'Уменьшить количество ' + product.name} disabled={quantity === 0} onClick={() => decrement(product.id)}><Minus /></button>
                      <span>{quantity}</span>
                      <button type="button" aria-label={'Добавить ' + product.name + ' в корзину'} disabled={quantity >= stock} onClick={() => add(product)}><Plus /></button>
                    </div>
                  </div>
                  <strong className="product-price">{product.price.toLocaleString('ru-RU')} ₽</strong>
                </article>
              )
            })}
          </div>
        </section>
      </div>
    </main>
  )
}
