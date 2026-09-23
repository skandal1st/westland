import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import { scanGroups } from './status'
import { categoryMappings, mappedCategory, resolveStoreCategory, sourceGroupPath } from '@/lib/catalog/group-mapping'
import { resolveCategoryId } from '@/lib/catalog/import'
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
    const mappings = categoryMappings(source.config)
    for (const id of ids) { if (categoryId) mappings[id] = categoryId; else delete mappings[id] }
    const config = { ...((source.config ?? {}) as Record<string, Prisma.InputJsonValue>), categoryGroups: mappings, catalogGroupTree: groups.map(g => ({ id: g.externalId, name: g.name, parentId: g.parentId })) }
    await tx.integrationConnection.update({ where: { id: connectionId }, data: { config } })
    const refs = await tx.externalReference.findMany({ where: { connectionId, entityType: 'product' }, select: { entityId: true, sourceData: true } })
    const categories = new Map<string, string | undefined>(), updates: Array<{ id: string; category: string }> = []
    for (const ref of refs) {
      const raw = (ref.sourceData ?? {}) as Record<string, unknown>
      const override = mappedCategory(raw, config), root = sourceGroupPath(raw, config).at(-1)
      if (!override && !root) continue
      const key = override ? 'site:' + override : root!.id
      if (!categories.has(key)) categories.set(key, override ? await resolveStoreCategory(tx, storeId, override) : await resolveCategoryId(tx, storeId, connectionId, root!.id, root!.name))
      const category = categories.get(key)
      if (category) updates.push({ id: ref.entityId, category })
    }
    let productsUpdated = 0
    for (let i = 0; i < updates.length; i += 500) productsUpdated += await tx.$executeRaw`UPDATE "Product" p SET "categoryId" = x.category, "updatedAt" = CURRENT_TIMESTAMP FROM jsonb_to_recordset(${JSON.stringify(updates.slice(i, i + 500))}::jsonb) AS x(id text, category text) WHERE p.id=x.id AND p."storeId"=${storeId} AND p."categoryId" IS DISTINCT FROM x.category`
    await tx.auditEntry.create({ data: { storeId, actorId, action: 'CategoryGroupsMapped', targetType: 'IntegrationConnection', targetId: connectionId, metadata: { externalIds: ids, categoryId, productsUpdated } } })
    return { ok: true, productsUpdated }
  }, { timeout: 120000 })
}
