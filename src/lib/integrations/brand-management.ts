/** Staff mapping entry point; provider file formats stay inside the adapter layer. */
export { setCategoryBrand } from './onec/manage-brands'

import { prisma } from '@/lib/db'
export async function readBrandAssignments(storeId: string, connectionId: string) {
  const refs = await prisma.externalReference.findMany({ where: { connectionId, entityType: 'brand' }, select: { entityId: true, externalId: true } })
  const brands = await prisma.brand.findMany({ where: { storeId, id: { in: refs.map(r => r.entityId) } }, select: { id: true, name: true, slug: true, _count: { select: { products: { where: { status: 'ACTIVE', content: { isNot: null }, OR: [{ categoryId: null }, { category: { hidden: false } }] } } } } } })
  const byId = new Map(brands.map(b => [b.id,b]))
  return new Map(refs.map(r => { const b=byId.get(r.entityId); return [r.externalId,b?{id:b.id,name:b.name,slug:b.slug,products:b._count.products}:null] }))
}
