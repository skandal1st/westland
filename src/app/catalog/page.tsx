import { Suspense } from 'react'
import { CatalogClient } from '@/components/CatalogClient'
import { StorefrontHeader } from '@/components/StorefrontHeader'
import { requireActiveUserPage } from '@/lib/authz'
import { loadStoreProfile } from '@/lib/store-profile'

export default async function CatalogPage() {
  // Closed-catalog policy is enforced server-side (mirrors /api/catalog).
  if (loadStoreProfile().policies.catalogRequiresAuth) await requireActiveUserPage()
  return (
    <>
      <StorefrontHeader />
      <Suspense fallback={null}>
        <CatalogClient />
      </Suspense>
    </>
  )
}
