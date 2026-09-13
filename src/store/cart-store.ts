'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { BROWSER_STORAGE_NAMESPACE } from '@/lib/app-config'
import type { DemoProduct } from '@/lib/demo-data'

type CartLine = { product: DemoProduct; quantity: number }
type CartState = {
  lines: CartLine[]
  open: boolean
  add: (product: DemoProduct) => void
  decrement: (id: string) => void
  remove: (id: string) => void
  setOpen: (value: boolean) => void
  clear: () => void
}

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      open: false,
      add: (product) => set((state) => {
        const found = state.lines.find((line) => line.product.id === product.id)
        return { lines: found
          ? state.lines.map((line) => line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line)
          : [...state.lines, { product, quantity: 1 }] }
      }),
      decrement: (id) => set((state) => ({
        lines: state.lines
          .map((line) => line.product.id === id ? { ...line, quantity: line.quantity - 1 } : line)
          .filter((line) => line.quantity > 0),
      })),
      remove: (id) => set((state) => ({ lines: state.lines.filter((line) => line.product.id !== id) })),
      setOpen: (open) => set({ open }),
      clear: () => set({ lines: [] }),
    }),
    { name: `${BROWSER_STORAGE_NAMESPACE}-cart-v2`, version: 2, partialize: ({ lines }) => ({ lines }) },
  ),
)
