import { Suspense } from 'react'
import { CatalogClient } from '@/components/CatalogClient'
import { StorefrontHeader } from '@/components/StorefrontHeader'
export default function CatalogPage() { return <><StorefrontHeader /><Suspense fallback={null}><CatalogClient /></Suspense></> }
