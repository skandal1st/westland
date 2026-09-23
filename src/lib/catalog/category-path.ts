import type { Prisma } from '@prisma/client'
import { resolveCategoryId } from './import'
import { categoryMappings, resolveStoreCategory, sourceGroupPath } from './group-mapping'

/** Canonical categories mirror the complete source path; staff rules replace a folder, not its descendants. */
export function categoryPathResolver(tx: Prisma.TransactionClient, storeId: string, connectionId: string, config: unknown) {
  const resolved = new Map<string, string>(), mappings = categoryMappings(config)
  return async (raw: Record<string, unknown>): Promise<string | undefined> => {
    const path = sourceGroupPath(raw, config).slice().reverse()
    let parentId: string | null = null
    for (const group of path) {
      let id = resolved.get(group.id)
      if (!id) {
        const override = mappings[group.id]
        id = override ? await resolveStoreCategory(tx, storeId, override) : await resolveCategoryId(tx, storeId, connectionId, group.id, group.name)
        if (!id) continue
        if (!override) {
          const category = await tx.category.findUniqueOrThrow({ where: { id }, select: { parentId: true } })
          // Reused merge targets keep their own position in the tree.
          const ref = await tx.externalReference.findUniqueOrThrow({ where: { connectionId_entityType_externalId: { connectionId, entityType: 'category', externalId: group.id } } })
          if (ref.entityId === id && id !== parentId && category.parentId !== parentId) {
            let ancestor = parentId
            const seen = new Set<string>([id])
            while (ancestor) {
              if (seen.has(ancestor)) throw Error('category_cycle')
              seen.add(ancestor)
              ancestor = (await tx.category.findFirstOrThrow({ where: { id: ancestor, storeId }, select: { parentId: true } })).parentId
            }
            await tx.category.update({ where: { id }, data: { parentId } })
          }
        }
        resolved.set(group.id, id)
      }
      parentId = id
    }
    return parentId ?? undefined
  }
}
