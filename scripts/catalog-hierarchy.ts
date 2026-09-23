/** Rebuild existing 1C folder assignments; dry-run is the default and rolls back. */
import { prisma } from '../src/lib/db'
import { scanGroups } from '../src/lib/integrations/onec/status'
import { rebuildCategoryHierarchy } from '../src/lib/integrations/onec/rebuild-categories'
import { lockCatalogSkus } from '../src/lib/catalog/source-sku'
import type { Prisma } from '@prisma/client'
async function main() {
  const args=process.argv.slice(2), apply=args.includes('--apply')
  if(args.length !== (apply?3:2) || args[0]!=='--store' || !args[1] || (apply && args[2]!=='--apply')) throw Error('Usage: catalog-hierarchy --store SLUG [--apply]')
  const store=await prisma.store.findUniqueOrThrow({where:{slug:args[1]}})
  const sources=await prisma.integrationConnection.findMany({where:{storeId:store.id,provider:'ONE_C',enabled:true,sourceState:'ACTIVE'}})
  if(sources.length!==1) throw Error('Exactly one active 1C source required')
  const sourceId=sources[0].id, rollback=Error('dry_run_rollback')
  let result:unknown
  try { await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id=${sourceId} FOR UPDATE`
    await lockCatalogSkus(tx,store.id)
    await tx.$queryRaw`SELECT id FROM "Category" WHERE "storeId"=${store.id} ORDER BY id FOR UPDATE`
    const source=await tx.integrationConnection.findFirstOrThrow({where:{id:sourceId,storeId:store.id,enabled:true,sourceState:'ACTIVE'}})
    const groups=await scanGroups(sourceId)
    if(!groups.length)throw Error('Source folder tree is empty')
    const config={...((source.config??{}) as Record<string,Prisma.InputJsonValue>),catalogGroupTree:groups.map(g=>({id:g.externalId,name:g.name,parentId:g.parentId}))}
    await tx.integrationConnection.update({where:{id:sourceId},data:{config}})
    const before=await tx.category.count({where:{storeId:store.id}})
    const productsUpdated=await rebuildCategoryHierarchy(tx,store.id,sourceId,config)
    result={mode:apply?'apply':'dry-run',store:store.slug,sourceId,sourceFolders:groups.length,categoriesBefore:before,categoriesAfter:await tx.category.count({where:{storeId:store.id}}),productsUpdated,products:await tx.product.count({where:{storeId:store.id}})}
    if(!apply)throw rollback
    await tx.auditEntry.create({data:{storeId:store.id,action:'CatalogHierarchyRebuilt',targetType:'IntegrationConnection',targetId:sourceId,metadata:result as Prisma.InputJsonValue}})
  },{timeout:600000,maxWait:30000}) } catch(error){if(error!==rollback)throw error}
  console.log(JSON.stringify(result))
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1}).finally(()=>prisma.$disconnect())
