import { giftRuleSchema } from '@/lib/promotions/gifts'
import { prisma } from '@/lib/db'
import { lockCatalogSkus } from './source-sku'

/** Retarget provider identities as well as products, so subsequent imports keep the merge. */
export async function mergeCategories(storeId: string, targetId: string, sourceIds: string[], actorId?: string) {
  const ids = Array.from(new Set(sourceIds))
  if (!ids.length || ids.includes(targetId)) throw new Error('invalid_selection')
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "IntegrationConnection" WHERE "storeId" = ${storeId} ORDER BY id FOR UPDATE`
    await lockCatalogSkus(tx, storeId)
    await tx.$queryRaw`SELECT id FROM "Category" WHERE "storeId" = ${storeId} ORDER BY id FOR UPDATE`
    const categories = await tx.category.findMany({ where: { storeId } })
    const byId = new Map(categories.map(c => [c.id, c]))
    const target = byId.get(targetId)
    if (!target || target.mergedIntoId || ids.some(id => !byId.has(id) || byId.get(id)!.mergedIntoId)) throw new Error('category_not_found')
    const selected = new Set(ids)
    let parent = target.parentId
    const seen = new Set<string>()
    while (parent && !seen.has(parent)) {
      if (selected.has(parent)) { await tx.category.update({ where: { id: targetId }, data: { parentId: null } }); break }
      seen.add(parent); parent = byId.get(parent)?.parentId ?? null
    }
    const moved = await tx.product.updateMany({ where: { storeId, categoryId: { in: ids } }, data: { categoryId: targetId } })
    // ExternalReference is one-to-one in both directions. Preserve each source category as a hidden alias.
    await tx.category.updateMany({ where: { storeId, mergedIntoId: { in: ids } }, data: { mergedIntoId: targetId } })
    await tx.category.updateMany({ where: { storeId, parentId: { in: ids }, id: { notIn: [...ids, targetId] } }, data: { parentId: targetId } })
    const rules = await tx.giftPromotion.findMany({ where: { storeId } })
    for (const promotion of rules) {
      const parsed = giftRuleSchema.safeParse(promotion.rule)
      if (!parsed.success) continue
      const rule = parsed.data
      let changed = false
      for (const field of [rule.condition, rule.reward]) { if (field.categoryId && selected.has(field.categoryId)) { field.categoryId = targetId; changed = true } }
      if (changed) await tx.giftPromotion.update({ where: { id: promotion.id }, data: { rule } })
    }
    await tx.category.updateMany({ where: { storeId, id: { in: ids } }, data: { hidden: true, mergedIntoId: targetId, parentId: null } })
    await tx.auditEntry.create({ data: { storeId, actorId, action: 'CategoriesMerged', targetType: 'Category', targetId,
      metadata: { sources: categories.filter(c => selected.has(c.id)).map(c => ({ id: c.id, name: c.name, slug: c.slug })), targetName: target.name, productsMoved: moved.count } } })
    return { productsMoved: moved.count, categoriesMerged: ids.length }
  }, { timeout: 60000 })
}
