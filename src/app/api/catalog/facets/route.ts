import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { loadStoreProfile } from '@/lib/store-profile'
import { catalogFacets } from '@/lib/catalog/read'
import { prisma } from '@/lib/db'
export const dynamic='force-dynamic'
export async function GET(request: Request) {
  const user=await getCurrentUser()
  if(loadStoreProfile().policies.catalogRequiresAuth&&!user)return NextResponse.json({error:'unauthorized'},{status:401})
  const url=new URL(request.url),query=(url.searchParams.get('q')??'').trim()
  if(query.length>200)return NextResponse.json({error:'invalid_query'},{status:400})
  const store=await getActiveStore()
  const channelId=url.searchParams.get('channel')
  const settings=await prisma.appSettings.findUnique({where:{storeId:store.id},select:{showOutOfStock:true}})
  return NextResponse.json(await catalogFacets({storeId:store.id,categorySlug:url.searchParams.get('category'),brandSlug:url.searchParams.get('brand'),query,channelId,hideOutOfStock:settings?.showOutOfStock===false}))
}
