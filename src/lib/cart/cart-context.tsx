'use client'

import { useSession } from 'next-auth/react'
import type { GiftOffer } from '@/lib/promotions/gifts'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

export type CartLine = {
  variantId: string
  sku: string
  sourceSku?: string | null
  displayName: string
  packaging: string
  quantity: number
  unitPrice: string | null
  lineTotal: string | null
  available: number | null
}
export type CartView = { gifts?: GiftOffer[]; cartId: string | null; version: number | null; channelId: string | null; currency: string; lines: CartLine[]; total: string }

type CartContextValue = {
  view: CartView
  ready: boolean
  loadError: string | null
  updating: boolean
  changeError: string | null
  retryChange: () => Promise<void>
  open: boolean
  setOpen: (open: boolean) => void
  refresh: () => Promise<void>
  setGift: (promotionId: string, variantId: string) => Promise<void>
  setItem: (variantId: string, quantity: number) => Promise<void>
  setChannel: (channelId: string) => Promise<void>
  quantityOf: (variantId: string) => number
  count: number
}

const empty: CartView = { cartId: null, version: null, channelId: null, currency: 'RUB', lines: [], total: '0.00' }
const CartContext = createContext<CartContextValue | null>(null)

export function CartProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status: sessionStatus } = useSession()
  const sessionIdentity = session?.user?.email
  const [view, setView] = useState<CartView>(empty)
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const refreshSequence = useRef(0)

  const apply = (data: unknown) => { if (data && typeof data === 'object' && 'lines' in (data as any)) setView(data as CartView) }

  const refresh = useCallback(async () => {
    const request = ++refreshSequence.current
    setLoadError(null)
    try {
      const response = await fetch('/api/cart')
      if (!response.ok) throw new Error('cart_unavailable')
      const data = await response.json()
      if (!data || !Array.isArray(data.lines)) throw new Error('invalid_cart')
      if (request !== refreshSequence.current) return
      apply(data)
      setReady(true)
      if (!changeLock.current) { setChangeError(null); pendingChange.current = null }
    } catch { if (request === refreshSequence.current) setLoadError('Не удалось загрузить корзину. Повторите запрос — сохранённые товары не удалены.') }
  }, [])

  useEffect(() => {
    if (sessionStatus === 'loading') return
    if (sessionStatus === 'authenticated') { void refresh(); return }
    ++refreshSequence.current
    setView(empty); setReady(false); setLoadError(null); setOpen(false)
  }, [refresh, sessionStatus, sessionIdentity])

  const changeLock = useRef(false)
  const pendingChange = useRef<{ path: string; payload: Record<string, unknown> } | null>(null)
  const [updating, setUpdating] = useState(false)
  const [changeError, setChangeError] = useState<string | null>(null)
  const change = useCallback(async (path: string, payload: Record<string, unknown>) => {
    if (changeLock.current) return
    changeLock.current = true; setUpdating(true); setChangeError(null)
    pendingChange.current = { path, payload }
    ++refreshSequence.current
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
      if (!response.ok) throw new Error('cart_change_failed')
      const data = await response.json()
      if (!data || !Array.isArray(data.lines) || !Number.isInteger(data.version)) throw new Error('invalid_cart')
      apply(data); setReady(true); setLoadError(null); pendingChange.current = null
    } catch { setChangeError('Не удалось получить результат изменения корзины. Повторите тот же запрос или обновите корзину.') }
    finally { changeLock.current = false; setUpdating(false) }
  }, [])
  const setGift = useCallback((promotionId: string, variantId: string) => change('/api/cart/gifts', { promotionId, variantId }), [change])
  const setItem = useCallback((variantId: string, quantity: number) => change('/api/cart/items', { variantId, quantity }), [change])
  const setChannel = useCallback((channelId: string) => change('/api/cart/channel', { channelId }), [change])
  const retryChange = useCallback(async () => {
    const pending = pendingChange.current
    if (pending) await change(pending.path, pending.payload)
  }, [change])

  const value = useMemo<CartContextValue>(() => ({
    view,
    ready,
    loadError,
    updating,
    changeError,
    retryChange,
    open,
    setOpen,
    refresh,
    setItem,
    setGift,
    setChannel,
    quantityOf: (variantId) => view.lines.find((line) => line.variantId === variantId)?.quantity ?? 0,
    count: view.lines.reduce((sum, line) => sum + line.quantity, 0),
  }), [view, ready, loadError, updating, changeError, retryChange, open, refresh, setItem, setGift, setChannel])

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart(): CartContextValue {
  const value = useContext(CartContext)
  if (!value) throw new Error('useCart must be used within a CartProvider')
  return value
}
