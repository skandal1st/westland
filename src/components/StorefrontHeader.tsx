'use client'

import { formatMoney } from '@/lib/money-format'

import Link from 'next/link'
import Image from 'next/image'
import { Menu, Package, ShoppingCart, UserRound, X } from 'lucide-react'
import { Suspense, useEffect, useRef, useState } from 'react'
import { CatalogSearch } from '@/components/CatalogSearch'
import { StorefrontContact } from '@/components/StorefrontContact'
import { readArray, useRemoteResource } from '@/lib/use-remote-resource'
import { PaletteSwitcher } from '@/components/PaletteSwitcher'
import { useStoreProfile } from '@/lib/store-profile-context'
import { useCart } from '@/lib/cart/cart-context'

import { CascadeCatalogMenu } from './CascadeCatalogMenu'
import type { CategoryNode } from '@/lib/catalog/tree'

type CatalogNav = { categories: CategoryNode[]; brands: { name: string; slug: string }[] }

const decodeNav = (value: unknown): CatalogNav => ({ categories: readArray(value, 'categories'), brands: readArray(value, 'brands') })

export function StorefrontHeader() {
  const profile = useStoreProfile()
  const header = useRef<HTMLElement>(null)
  const [menuTop, setMenuTop] = useState(94)
  const [menuOpen, setMenuOpen] = useState(false)
  const navigation = useRemoteResource('/api/catalog/nav', decodeNav)
  const nav = navigation.data ?? { categories: [], brands: [] }
  const { view, count, setOpen: setCartOpen } = useCart()
  const total = view.total

  useEffect(() => {
    if (!menuOpen) return
    const position = () => setMenuTop(header.current?.getBoundingClientRect().bottom ?? 94)
    position()
    const observer = new ResizeObserver(position)
    if (header.current) observer.observe(header.current)
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('keydown', close); observer.disconnect() }
  }, [menuOpen])
  return (
    <header className="site-header" ref={header}>
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
        <><button type="button" className="catalog-menu-shade" style={{top:menuTop}} aria-label="Закрыть меню каталога" onClick={()=>setMenuOpen(false)}/><div className="mega-menu hierarchy-menu" id="catalog-menu" style={{top:menuTop,height:'min(620px, calc(100dvh - '+(menuTop+12)+'px))'}}>
          {navigation.loading ? <p role="status">Загрузка категорий…</p> : navigation.error ? <div role="alert"><p>{navigation.error}</p><button type="button" onClick={navigation.reload}>Повторить загрузку меню</button></div> : <CascadeCatalogMenu nodes={nav.categories} onNavigate={()=>setMenuOpen(false)}/>}
        </div></>
      ) : null}
    </header>
  )
}
