'use client'

import Link from 'next/link'
import Image from 'next/image'
import { Menu, Package, Search, ShoppingCart, UserRound, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { PaletteSwitcher } from '@/components/PaletteSwitcher'
import { useStoreProfile } from '@/lib/store-profile-context'
import { useCart } from '@/lib/cart/cart-context'

type CatalogNav = { categories: { name: string; slug: string }[]; brands: { name: string; slug: string }[] }

export function StorefrontHeader() {
  const profile = useStoreProfile()
  const [menuOpen, setMenuOpen] = useState(false)
  const [nav, setNav] = useState<CatalogNav>({ categories: [], brands: [] })
  const { view, count, setOpen: setCartOpen } = useCart()
  const total = view.total

  useEffect(() => {
    let active = true
    fetch('/api/catalog/nav')
      .then((r) => (r.ok ? r.json() : { categories: [], brands: [] }))
      .then((data) => { if (active) setNav({ categories: data.categories ?? [], brands: data.brands ?? [] }) })
      .catch(() => {})
    return () => { active = false }
  }, [])
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand-logo" href="/" aria-label={`${profile.identity.name} — на главную`}>
          <Image src="/brand/westside-logo.png" alt={profile.identity.name} width={60} height={60} priority />
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
        <Link className="header-icon" href="/account/orders" aria-label="Мои заказы"><Package /></Link>
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
            {nav.categories.length === 0
              ? <p className="mega-empty">Категории появятся после импорта каталога.</p>
              : nav.categories.map((category) => <Link key={category.slug} href={'/catalog?category=' + encodeURIComponent(category.slug)} onClick={() => setMenuOpen(false)}>{category.name}<span>›</span></Link>)}
          </div>
          <div className="mega-column">
            <strong>Бренды</strong>
            {nav.brands.length === 0
              ? <p className="mega-empty">Бренды появятся после импорта каталога.</p>
              : nav.brands.map((brand) => <Link key={brand.slug} href={'/catalog?brand=' + encodeURIComponent(brand.slug)} onClick={() => setMenuOpen(false)}>{brand.name}<span>›</span></Link>)}
          </div>
        </div>
      ) : null}
    </header>
  )
}
