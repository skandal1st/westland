'use client'

import { SessionProvider } from 'next-auth/react'
import { StoreProfileProvider } from '@/lib/store-profile-context'
import { CartProvider } from '@/lib/cart/cart-context'
import type { PublicStoreProfile } from '@/lib/store-profile'

export function Providers({
  profile,
  children,
}: {
  profile: PublicStoreProfile
  children: React.ReactNode
}) {
  return (
    <SessionProvider>
      <StoreProfileProvider profile={profile}>
        <CartProvider>{children}</CartProvider>
      </StoreProfileProvider>
    </SessionProvider>
  )
}
