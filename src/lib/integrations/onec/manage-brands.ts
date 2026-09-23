import { prisma } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import { scanGroups } from '@/lib/integrations/onec/status'
import { resolveBrandId } from '@/lib/catalog/import'
import { mappedBrand, type BrandAncestor } from '@/lib/catalog/brand-mapping'
import { lockCatalogSkus } from '@/lib/catalog/source-sku'

export async function setCategoryBrand(storeId: string, connectionId: string, externalId: string, isBrand: boolean, actorId?: string) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE id = ${connectionId} FOR UPDATE`
    const connection = await tx.integrationConnection.findFirst({ where: { id: connectionId, storeId, sourceState: 'ACTIVE' } })
    if (!connection) throw new Error('source_changed')
    const groups = await scanGroups(connectionId)
    const byId = new Map(groups.map(g => [g.externalId, g]))
    if (!byId.has(externalId)) throw new Error('group_not_found')
    const config = (connection.config ?? {}) as Record<string, Prisma.InputJsonValue>
    const selected = new Set(Array.isArray(config.brandGroups) ? config.brandGroups.filter((v): v is string => typeof v === 'string') : [])
    if (isBrand) selected.add(externalId); else selected.delete(externalId)
    const nextConfig = { ...config, brandGroups: Array.from(selected), catalogGroupTree: groups.map(g => ({ id: g.externalId, name: g.name, parentId: g.parentId })) }
    await tx.integrationConnection.update({ where: { id: connectionId }, data: { config: nextConfig } })
    await lockCatalogSkus(tx, storeId)
    const refs = await tx.externalReference.findMany({ where: { connectionId, entityType: 'product' }, select: { entityId: true, sourceData: true } })
    const brands = new Map<string, string>()
    // Create marked brands even when they currently have no imported canonical products.
    for (const id of Array.from(selected)) { const group = byId.get(id); if (group) brands.set(id, (await resolveBrandId(tx, storeId, connectionId, id, group.name))!) }
    const updates: Array<{ id: string; brand: string | null }> = []
    for (const ref of refs) {
      const raw = (ref.sourceData ?? {}) as Record<string, unknown>
      const path: BrandAncestor[] = []
      let current = typeof raw.groupId === 'string' ? raw.groupId : undefined
      const seen = new Set<string>()
      while (current && byId.has(current) && !seen.has(current)) {
        seen.add(current); const group = byId.get(current)!
        path.push({ id: current, name: group.name }); current = group.parentId ?? undefined
      }
      // An older product absent from a partial generation can use its stored ancestry.
      const mapped = mappedBrand(path.length ? { brandPath: path } : raw, nextConfig)
      if (mapped === undefined) continue
      if (mapped && !brands.has(mapped.id)) brands.set(mapped.id, (await resolveBrandId(tx, storeId, connectionId, mapped.id, mapped.name))!)
      updates.push({ id: ref.entityId, brand: mapped ? brands.get(mapped.id)! : null })
    }
    let productsUpdated = 0
    for (let i = 0; i < updates.length; i += 500) {
      productsUpdated += await tx.$executeRaw`UPDATE "Product" p SET "brandId" = x.brand, "updatedAt" = CURRENT_TIMESTAMP
        FROM jsonb_to_recordset(${JSON.stringify(updates.slice(i, i + 500))}::jsonb) AS x(id text, brand text)
        WHERE p.id = x.id AND p."storeId" = ${storeId} AND p."brandId" IS DISTINCT FROM x.brand`
    }
    await tx.auditEntry.create({ data: { storeId, actorId, action: 'CategoryBrandMapped', targetType: 'IntegrationConnection', targetId: connectionId,
      metadata: { externalId, isBrand, productsUpdated } } })
    return { ok: true, brandCount: selected.size, productsUpdated }
  }, { timeout: 120000 })
}
