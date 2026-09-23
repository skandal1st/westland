'use client'
import { CartGifts } from './CartGifts'

import { formatMoney } from '@/lib/money-format'

import Link from 'next/link'
import { Minus, Plus, ShoppingBag, Trash2, X } from 'lucide-react'
import { useCart } from '@/lib/cart/cart-context'

export function CartDrawer() {
  const { view, ready, loadError, changeError, updating, refresh, retryChange, open, setOpen, setItem } = useCart()
  const lines = view.lines
  if (!open) return null
  const currency = view.currency === 'RUB' ? '₽' : view.currency
  return (
    <div className="drawer-backdrop" onMouseDown={() => setOpen(false)}>
      <aside className="cart-drawer" onMouseDown={(event) => event.stopPropagation()} aria-label="Корзина">
        <div className="drawer-title"><div><h2>Ваша заявка</h2><span>{lines.length} позиций</span></div><button className="icon-button" aria-label="Закрыть корзину" onClick={() => setOpen(false)}><X /></button></div>
        {!ready && !loadError ? <p role="status">Загрузка корзины…</p> : null}
        {loadError ? <div className="load-error" role="alert"><span>{loadError}</span><button type="button" onClick={refresh}>Повторить загрузку корзины</button></div> : null}
        {changeError ? <div className="load-error" role="alert"><span>{changeError}</span><button type="button" disabled={updating} onClick={retryChange}>Повторить изменение корзины</button></div> : null}
        <div className="cart-lines">
          {!ready || loadError ? null : lines.length === 0 ? <div className="empty-cart"><ShoppingBag /><strong>Корзина пуста</strong><p>Добавьте товары из каталога</p></div> : lines.map((line) => (
            <div className="cart-line" key={line.variantId}>
              <div className="cart-line-info">
                <strong>{line.displayName}</strong>
                <span>{line.packaging || line.sourceSku || line.sku}</span>
                <b>{line.unitPrice != null ? `${formatMoney(line.unitPrice)} ${currency}` : 'цена уточняется'}</b>
              </div>
              <div className="quantity">
                <button disabled={updating} onClick={() => setItem(line.variantId, line.quantity - 1)} aria-label="Уменьшить"><Minus /></button>
                <span>{line.quantity}</span>
                <button onClick={() => setItem(line.variantId, line.quantity + 1)} aria-label="Увеличить" disabled={updating || line.quantity >= 100000}><Plus /></button>
              </div>
              <button className="remove" disabled={updating} onClick={() => setItem(line.variantId, 0)} aria-label="Удалить"><Trash2 /></button>
            </div>
          ))}
        </div>
        <CartGifts />
        <div className="drawer-footer">
          <div className="cart-total"><span>Итого</span><strong>{formatMoney(view.total)} {currency}</strong></div>
          {ready && !loadError && !changeError && !updating && lines.length > 0 ? <Link className="button button-primary" href="/checkout" onClick={() => setOpen(false)}>Перейти к заявке</Link> : <button className="button button-primary" disabled>Перейти к заявке</button>}
          <small>Заявка не резервирует товар. Счёт доступен после подтверждения состава и суммы в 1С.</small>
        </div>
      </aside>
    </div>
  )
}
