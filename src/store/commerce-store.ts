'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { BROWSER_STORAGE_NAMESPACE } from '@/lib/app-config'
import type { PaymentMethod } from '@/lib/commerce'

export type DeliveryPoint = {
  id: string
  name: string
  city: string
  address: string
  contactName: string
  contactPhone: string
}

type CommerceState = {
  paymentMethod: PaymentMethod
  deliveryPoints: DeliveryPoint[]
  selectedDeliveryPointId: string
  setPaymentMethod: (method: PaymentMethod) => void
  setSelectedDeliveryPoint: (id: string) => void
  addDeliveryPoint: (point: Omit<DeliveryPoint, 'id'>) => void
}

export const useCommerceStore = create<CommerceState>()(
  persist(
    (set) => ({
      paymentMethod: 'BANK_TRANSFER',
      deliveryPoints: [],
      selectedDeliveryPointId: '',
      setPaymentMethod: (paymentMethod) => set({ paymentMethod }),
      setSelectedDeliveryPoint: (selectedDeliveryPointId) => set({ selectedDeliveryPointId }),
      addDeliveryPoint: (point) => set((state) => {
        const id = crypto.randomUUID()
        return {
          deliveryPoints: [...state.deliveryPoints, { ...point, id }],
          selectedDeliveryPointId: state.selectedDeliveryPointId || id,
        }
      }),
    }),
    {
      name: `${BROWSER_STORAGE_NAMESPACE}-commerce-v1`,
      version: 1,
      partialize: ({ paymentMethod, deliveryPoints, selectedDeliveryPointId }) => ({ paymentMethod, deliveryPoints, selectedDeliveryPointId }),
    },
  ),
)
