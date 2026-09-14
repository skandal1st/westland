'use client'

import Link from 'next/link'
import { Minus, Plus, ShoppingBag, Trash2, X } from 'lucide-react'
import { useCart } from '@/lib/cart/cart-context'

export function CartDrawer() {
  const { view, open, setOpen, setItem } = useCart()
  const lines = view.lines
  if (!open) return null
  const currency = view.currency === 'RUB' ? '₽' : view.currency
  return (
    <div className="drawer-backdrop" onMouseDown={() => setOpen(false)}>
      <aside className="cart-drawer" onMouseDown={(event) => event.stopPropagation()} aria-label="Корзина">
        <div className="drawer-title"><div><h2>Ваш заказ</h2><span>{lines.length} позиций</span></div><button className="icon-button" aria-label="Закрыть корзину" onClick={() => setOpen(false)}><X /></button></div>
        <div className="cart-lines">
          {lines.length === 0 ? <div className="empty-cart"><ShoppingBag /><strong>Корзина пуста</strong><p>Добавьте товары из каталога</p></div> : lines.map((line) => (
            <div className="cart-line" key={line.variantId}>
              <div className="cart-line-info">
                <strong>{line.displayName}</strong>
                <span>{line.packaging || line.sku}</span>
                <b>{line.unitPrice != null ? `${line.unitPrice.toLocaleString('ru-RU')} ${currency}` : 'цена уточняется'}</b>
              </div>
              <div className="quantity">
                <button onClick={() => setItem(line.variantId, line.quantity - 1)} aria-label="Уменьшить"><Minus /></button>
                <span>{line.quantity}</span>
                <button onClick={() => setItem(line.variantId, line.quantity + 1)} aria-label="Увеличить" disabled={line.available != null && line.quantity >= line.available}><Plus /></button>
              </div>
              <button className="remove" onClick={() => setItem(line.variantId, 0)} aria-label="Удалить"><Trash2 /></button>
            </div>
          ))}
        </div>
        <div className="drawer-footer">
          <div className="cart-total"><span>Итого</span><strong>{view.total.toLocaleString('ru-RU')} {currency}</strong></div>
          <Link className={'button button-primary ' + (lines.length === 0 ? 'disabled' : '')} href="/checkout" onClick={() => setOpen(false)}>Оформить заказ</Link>
          <small>После оформления мы сформируем PDF-счёт.</small>
        </div>
      </aside>
    </div>
  )
}
