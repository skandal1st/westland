import { rebuildCategoryHierarchy } from './rebuild-categories'
import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import { scanGroups } from './status'
import { categoryMappings, mappedCategory } from '@/lib/catalog/group-mapping'
import { lockCatalogSkus } from '@/lib/catalog/source-sku'
export async function readCategoryGroups(connectionId: string) {
  const source = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
  const mappings = categoryMappings(source.config)
  const groups = await scanGroups(connectionId)
  const tree = groups.map(g => ({ id: g.externalId, name: g.name, parentId: g.parentId }))
  const config = { categoryGroups: mappings, catalogGroupTree: tree }
  return groups.map(g => ({ ...g, categoryId: mappings[g.externalId] ?? null, effectiveCategoryId: mappedCategory({ groupId: g.externalId }, config) ?? null }))
}
/** One source folder has one site target; descendants inherit the nearest explicit rule. */
export async function setCategoryGroups(storeId: string, connectionId: string, externalIds: string[], categoryId: string | null, actorId?: string) {
  const ids = Array.from(new Set(externalIds))
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${connectionId} FOR UPDATE`
    const source = await tx.integrationConnection.findFirst({ where: { id: connectionId, storeId, enabled: true, sourceState: 'ACTIVE' } })
    if (!source) throw Error('source_changed')
    await lockCatalogSkus(tx, storeId)
    await tx.$queryRaw`SELECT id FROM "Category" WHERE "storeId" = ${storeId} ORDER BY id FOR UPDATE`
    if (categoryId && !await tx.category.findFirst({ where: { id: categoryId, storeId, mergedIntoId: null } })) throw Error('invalid_category')
    const groups = await scanGroups(connectionId), byId = new Set(groups.map(g => g.externalId))
    if (!ids.length || ids.some(id => !byId.has(id))) throw Error('group_not_found')
    if(categoryId) {
      const targets=await tx.externalReference.findMany({where:{connectionId,entityType:'category',entityId:categoryId},select:{externalId:true}})
      const parents=new Map(groups.map(g=>[g.externalId,g.parentId]))
      for(const target of targets){let current=parents.get(target.externalId);const seen=new Set<string>();while(current&&!seen.has(current)){if(ids.includes(current))throw Error('category_cycle');seen.add(current);current=parents.get(current)}}
    }
    const mappings = categoryMappings(source.config)
    for (const id of ids) { if (categoryId) mappings[id] = categoryId; else delete mappings[id] }
    const config = { ...((source.config ?? {}) as Record<string, Prisma.InputJsonValue>), categoryGroups: mappings, catalogGroupTree: groups.map(g => ({ id: g.externalId, name: g.name, parentId: g.parentId })) }
    await tx.integrationConnection.update({ where: { id: connectionId }, data: { config } })
    const productsUpdated = await rebuildCategoryHierarchy(tx, storeId, connectionId, config)
    await tx.auditEntry.create({ data: { storeId, actorId, action: 'CategoryGroupsMapped', targetType: 'IntegrationConnection', targetId: connectionId, metadata: { externalIds: ids, categoryId, productsUpdated } } })
    return { ok: true, productsUpdated }
  }, { timeout: 120000 })
}
