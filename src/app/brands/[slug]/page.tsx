import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { CatalogClient } from '@/components/CatalogClient'
import { StorefrontHeader } from '@/components/StorefrontHeader'
import { requireActiveUserPage } from '@/lib/authz'
import { loadStoreProfile } from '@/lib/store-profile'
import { getActiveStore } from '@/lib/store'
import { prisma } from '@/lib/db'
export const dynamic='force-dynamic'
export default async function BrandPage({params}:{params:{slug:string}}) {
  if(loadStoreProfile().policies.catalogRequiresAuth)await requireActiveUserPage()
  const store=await getActiveStore()
  const brand=await prisma.brand.findUnique({where:{storeId_slug:{storeId:store.id,slug:params.slug}},select:{name:true,slug:true}})
  if(!brand)notFound()
  return <><StorefrontHeader/><Suspense fallback={<p role="status">Загрузка товаров бренда…</p>}><CatalogClient fixedBrand={brand}/></Suspense></>
}
