'use client'

import Link from 'next/link'
import Image from 'next/image'
import { Menu, Search, ShoppingCart, UserRound, X } from 'lucide-react'
import { useState } from 'react'
import { PaletteSwitcher } from '@/components/PaletteSwitcher'
import { brands, categories } from '@/lib/demo-data'
import { useCart } from '@/store/cart-store'

export function StorefrontHeader() {
  const [menuOpen, setMenuOpen] = useState(false)
  const lines = useCart((state) => state.lines)
  const setCartOpen = useCart((state) => state.setOpen)
  const count = lines.reduce((sum, line) => sum + line.quantity, 0)
  const total = lines.reduce((sum, line) => sum + line.quantity * line.product.price, 0)
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand-logo" href="/" aria-label="Westside — на главную">
          <Image src="/brand/westside-logo.png" alt="Westside" width={60} height={60} priority />
        </Link>
        <button className="catalog-button" onClick={() => setMenuOpen((value) => !value)} aria-expanded={menuOpen}>
          {menuOpen ? <X /> : <Menu />}<span>Каталог</span>
        </button>
        <Link className="promo-link" href="/catalog?filter=new">Новинки</Link>
        <label className="search-box">
          <Search aria-hidden="true" />
          <input aria-label="Поиск по каталогу" placeholder="Поиск по товарам, брендам и категориям" />
        </label>
        <div className="contact">
          <small>ПН–ПТ, 09:00–18:00</small>
          <strong>+7 (000) 000-00-00</strong>
        </div>
        <PaletteSwitcher />
        <Link className="header-icon" href="/account/locations" aria-label="Личный кабинет"><UserRound /></Link>
        <button className="cart-button" onClick={() => setCartOpen(true)} aria-label="Открыть корзину">
          <ShoppingCart /><span>{total.toLocaleString('ru-RU')} ₽</span>{count > 0 ? <b>{count}</b> : null}
        </button>
      </div>
      <div className="mobile-search"><Search /><input aria-label="Поиск" placeholder="Поиск по каталогу" /></div>
      {menuOpen ? (
        <div className="mega-menu">
          <div className="mega-column">
            <strong>Все товары</strong>
            {categories.map((category, index) => <Link className={index === 1 ? 'active' : ''} key={category.name} href={'/catalog?category=' + encodeURIComponent(category.name)} onClick={() => setMenuOpen(false)}>{category.name}<span>›</span></Link>)}
          </div>
          <div className="mega-column">
            <strong>Бренды</strong>
            {brands.map((brand, index) => <Link className={index === 0 ? 'active' : ''} key={brand} href={'/catalog?brand=' + encodeURIComponent(brand)} onClick={() => setMenuOpen(false)}>{brand}<span>›</span></Link>)}
          </div>
          <div className="mega-column mega-feature">
            <strong>Популярные разделы</strong>
            <Link className="active" href="/catalog?category=Табак">Табак 25 г</Link>
            <Link href="/catalog?category=Табак">Табак 100 г</Link>
            <Link href="/catalog?category=Аксессуары">Аксессуары</Link>
          </div>
        </div>
      ) : null}
    </header>
  )
}
