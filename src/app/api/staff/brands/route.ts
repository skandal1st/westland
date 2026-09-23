import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
export const dynamic = 'force-dynamic'
export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()
  const brands = await prisma.brand.findMany({ where: { storeId: store.id }, orderBy: { name: 'asc' }, select: { id: true, name: true, slug: true, _count: { select: { products: true } } } })
  return NextResponse.json({ brands })
}
