'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

export type CartLine = {
  variantId: string
  sku: string
  displayName: string
  packaging: string
  quantity: number
  unitPrice: number | null
  lineTotal: number | null
  available: number | null
}
export type CartView = { channelId: string | null; currency: string; lines: CartLine[]; total: number }

type CartContextValue = {
  view: CartView
  open: boolean
  setOpen: (open: boolean) => void
  refresh: () => Promise<void>
  setItem: (variantId: string, quantity: number) => Promise<void>
  setChannel: (channelId: string) => Promise<void>
  quantityOf: (variantId: string) => number
  count: number
}

const empty: CartView = { channelId: null, currency: 'RUB', lines: [], total: 0 }
const CartContext = createContext<CartContextValue | null>(null)

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [view, setView] = useState<CartView>(empty)
  const [open, setOpen] = useState(false)

  const apply = (data: unknown) => { if (data && typeof data === 'object' && 'lines' in (data as any)) setView(data as CartView) }

  const refresh = useCallback(async () => {
    const response = await fetch('/api/cart')
    if (response.ok) apply(await response.json())
    else setView(empty)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const setItem = useCallback(async (variantId: string, quantity: number) => {
    const response = await fetch('/api/cart/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ variantId, quantity }) })
    if (response.ok) apply(await response.json())
  }, [])

  const setChannel = useCallback(async (channelId: string) => {
    const response = await fetch('/api/cart/channel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId }) })
    if (response.ok) apply(await response.json())
  }, [])

  const value = useMemo<CartContextValue>(() => ({
    view,
    open,
    setOpen,
    refresh,
    setItem,
    setChannel,
    quantityOf: (variantId) => view.lines.find((line) => line.variantId === variantId)?.quantity ?? 0,
    count: view.lines.reduce((sum, line) => sum + line.quantity, 0),
  }), [view, open, refresh, setItem, setChannel])

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart(): CartContextValue {
  const value = useContext(CartContext)
  if (!value) throw new Error('useCart must be used within a CartProvider')
  return value
}
