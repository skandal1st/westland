'use client'

import { createContext, useContext } from 'react'
import type { PublicStoreProfile } from '@/lib/store-profile'

const StoreProfileContext = createContext<PublicStoreProfile | null>(null)

export function StoreProfileProvider({
  profile,
  children,
}: {
  profile: PublicStoreProfile
  children: React.ReactNode
}) {
  return <StoreProfileContext.Provider value={profile}>{children}</StoreProfileContext.Provider>
}

export function useStoreProfile(): PublicStoreProfile {
  const value = useContext(StoreProfileContext)
  if (!value) throw new Error('useStoreProfile must be used within a StoreProfileProvider')
  return value
}
