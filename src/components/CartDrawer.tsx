'use client'

import Link from 'next/link'
import { Minus, Plus, ShoppingBag, Trash2, X } from 'lucide-react'
import { useCart } from '@/store/cart-store'

export function CartDrawer() {
  const { lines, open, add, decrement, remove, setOpen } = useCart()
  const total = lines.reduce((sum, line) => sum + line.quantity * line.product.price, 0)
  if (!open) return null
  return (
    <div className="drawer-backdrop" onMouseDown={() => setOpen(false)}>
      <aside className="cart-drawer" onMouseDown={(event) => event.stopPropagation()} aria-label="Корзина">
        <div className="drawer-title"><div><h2>Ваш заказ</h2><span>{lines.length} позиций</span></div><button className="icon-button" aria-label="Закрыть корзину" onClick={() => setOpen(false)}><X /></button></div>
        <div className="cart-lines">
          {lines.length === 0 ? <div className="empty-cart"><ShoppingBag /><strong>Корзина пуста</strong><p>Добавьте товары из каталога</p></div> : lines.map(({ product, quantity }) => (
            <div className="cart-line" key={product.id}>
              <div className="mini-pack" style={{ background: product.tone }}>{product.brand.slice(0, 2)}</div>
              <div className="cart-line-info"><strong>{product.name}</strong><span>{product.packaging}</span><b>{product.price.toLocaleString('ru-RU')} ₽</b></div>
              <div className="quantity"><button onClick={() => decrement(product.id)}><Minus /></button><span>{quantity}</span><button onClick={() => add(product)}><Plus /></button></div>
              <button className="remove" onClick={() => remove(product.id)} aria-label="Удалить"><Trash2 /></button>
            </div>
          ))}
        </div>
        <div className="drawer-footer">
          <div className="cart-total"><span>Итого</span><strong>{total.toLocaleString('ru-RU')} ₽</strong></div>
          <Link className={'button button-primary ' + (lines.length === 0 ? 'disabled' : '')} href="/checkout" onClick={() => setOpen(false)}>Оформить заказ</Link>
          <small>После оформления мы сформируем PDF-счёт.</small>
        </div>
      </aside>
    </div>
  )
}
