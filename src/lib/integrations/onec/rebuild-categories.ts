import type { Prisma } from '@prisma/client'
import { categoryPathResolver } from '@/lib/catalog/category-path'
import { savedGroupTree } from '@/lib/catalog/group-mapping'
export async function rebuildCategoryHierarchy(tx: Prisma.TransactionClient, storeId: string, connectionId: string, config: unknown) {
  const resolve = categoryPathResolver(tx, storeId, connectionId, config)
  for (const group of savedGroupTree(config)) await resolve({ groupId: group.id })
  const refs = await tx.externalReference.findMany({ where: { connectionId, entityType:'product' }, select:{entityId:true,sourceData:true} })
  const updates: Array<{id:string;category:string}> = []
  for (const ref of refs) { const category=await resolve((ref.sourceData??{}) as Record<string,unknown>);if(category)updates.push({id:ref.entityId,category}) }
  let productsUpdated=0
  for(let i=0;i<updates.length;i+=500) productsUpdated += await tx.$executeRaw`UPDATE "Product" p SET "categoryId"=x.category,"updatedAt"=CURRENT_TIMESTAMP FROM jsonb_to_recordset(${JSON.stringify(updates.slice(i,i+500))}::jsonb) AS x(id text,category text) WHERE p.id=x.id AND p."storeId"=${storeId} AND p."categoryId" IS DISTINCT FROM x.category`
  return productsUpdated
}
