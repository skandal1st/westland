'use client'

import { formatMoney } from '@/lib/money-format'

import Link from 'next/link'
import Image from 'next/image'
import { Menu, Package, ShoppingCart, UserRound, X } from 'lucide-react'
import { Suspense, useEffect, useState } from 'react'
import { CatalogSearch } from '@/components/CatalogSearch'
import { StorefrontContact } from '@/components/StorefrontContact'
import { readArray, useRemoteResource } from '@/lib/use-remote-resource'
import { PaletteSwitcher } from '@/components/PaletteSwitcher'
import { useStoreProfile } from '@/lib/store-profile-context'
import { useCart } from '@/lib/cart/cart-context'

type CatalogNav = { categories: { name: string; slug: string }[]; brands: { name: string; slug: string }[] }

const decodeNav = (value: unknown): CatalogNav => ({ categories: readArray(value, 'categories'), brands: readArray(value, 'brands') })

export function StorefrontHeader() {
  const profile = useStoreProfile()
  const [menuOpen, setMenuOpen] = useState(false)
  const navigation = useRemoteResource('/api/catalog/nav', decodeNav)
  const nav = navigation.data ?? { categories: [], brands: [] }
  const { view, count, setOpen: setCartOpen } = useCart()
  const total = view.total

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [menuOpen])
  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand-logo" href="/" aria-label={`${profile.identity.name} — на главную`}>
          <Image src="/brand/westside-logo.png" alt={profile.identity.name} width={60} height={60} priority />
        </Link>
        <button className="catalog-button" aria-label="Каталог" aria-controls="catalog-menu" onClick={() => setMenuOpen((value) => !value)} aria-expanded={menuOpen}>
          {menuOpen ? <X /> : <Menu />}<span>Каталог</span>
        </button>
        <Suspense fallback={null}><CatalogSearch className="search-box" onSearch={() => setMenuOpen(false)} /></Suspense>
        <div className="header-contact"><StorefrontContact /></div>
        <PaletteSwitcher />
        <Link className="header-icon" href="/account/orders" aria-label="Мои заказы"><Package /></Link>
        <Link className="header-icon" href="/account/locations" aria-label="Личный кабинет"><UserRound /></Link>
        <button className="cart-button" onClick={() => setCartOpen(true)} aria-label="Открыть корзину">
          <ShoppingCart /><span>{formatMoney(total)} ₽</span>{count > 0 ? <b>{count}</b> : null}
        </button>
      </div>
      <Suspense fallback={null}><CatalogSearch className="mobile-search" onSearch={() => setMenuOpen(false)} /></Suspense>
      {menuOpen ? (
        <div className="mega-menu" id="catalog-menu">
          <Link href="/catalog" onClick={() => setMenuOpen(false)}>Весь каталог</Link>
          <div className="menu-contacts"><StorefrontContact /></div>
          {navigation.loading ? <p role="status">Загрузка категорий и брендов…</p> : navigation.error ? <div role="alert"><p>{navigation.error}</p><button type="button" onClick={navigation.reload}>Повторить загрузку меню</button></div> : <>
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
          </>}
        </div>
      ) : null}
    </header>
  )
}
