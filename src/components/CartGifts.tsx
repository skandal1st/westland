'use client'
import { useState } from 'react'
import type { GiftCandidate, GiftOffer } from '@/lib/promotions/gifts'
import { readArray, useRemoteResource } from '@/lib/use-remote-resource'
import { useCart } from '@/lib/cart/cart-context'
const decode = (v: unknown) => readArray<GiftCandidate>(v, 'options')
function GiftChoice({ offer }: { offer: GiftOffer }) {
  const { setGift, updating } = useCart()
  const [query, setQuery] = useState(''), [search, setSearch] = useState('')
  const options = useRemoteResource('/api/cart/gifts?promotionId=' + encodeURIComponent(offer.id) + '&q=' + encodeURIComponent(search), decode)
  return <div><div className="admin-toolbar"><label>Поиск подарка<input value={query} onChange={e => setQuery(e.target.value)} placeholder="Название или артикул" /></label><button type="button" onClick={() => setSearch(query.trim())}>Найти</button></div>
    {options.loading ? <p role="status">Загрузка подарков…</p> : options.error ? <p role="alert">{options.error} <button onClick={options.reload}>Повторить</button></p> : <label>Выберите промотовар<select disabled={updating} aria-label={'Подарок по акции ' + offer.name} value={offer.selection ?? ''} onChange={e => { if (e.target.value) void setGift(offer.id, e.target.value) }}><option value="">Выберите товар</option>{offer.gift && !options.data?.some(o => o.variantId === offer.gift?.variantId) ? <option value={offer.gift.variantId}>{offer.gift.name}</option> : null}{options.data?.map(o => <option value={o.variantId} key={o.variantId}>{o.name} · {o.sourceSku ?? o.sku}</option>)}<option value="SKIP">Не добавлять подарок</option></select></label>}
    {!options.loading && !options.data?.length ? <small>Подходящих подарков с достаточным остатком не найдено. Измените поиск или откажитесь от подарка.</small> : null}
  </div>
}
export function CartGifts() {
  const { view, setGift, updating } = useCart()
  if (!view.gifts?.length) return null
  return <section className="cart-gifts" aria-label="Промотовары"><h3>Промотовары</h3>{view.gifts.map(offer => <div key={offer.id} className="cart-gift"><strong>{offer.name}</strong>
    {offer.quantity > 0 ? <>
      {offer.gift ? <p>{offer.gift.name} × {offer.quantity} · Бесплатно</p> : offer.selection === 'SKIP' ? <p>Подарок не добавлен по вашему выбору.</p> : offer.unavailable ? <p>Подарок недоступен на выбранном складе.</p> : <p>Вам доступно {offer.quantity} шт. в подарок.</p>}
      {offer.requiresChoice ? <GiftChoice offer={offer} /> : offer.selection === 'SKIP' ? <button type="button" disabled={updating} onClick={() => setGift(offer.id, 'AUTO')}>Добавить подарок</button> : offer.gift ? <button type="button" disabled={updating} onClick={() => setGift(offer.id, 'SKIP')}>Не добавлять подарок</button> : null}
    </> : null}
    {offer.remaining > 0 ? <small>Ещё {offer.remaining} шт. подходящих товаров до следующего подарка.</small> : null}
  </div>)}<small>Наличие промотоваров проверяется при оформлении заявки. Окончательный состав подтвердит 1С.</small></section>
}
