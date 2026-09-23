import type { Prisma } from '@prisma/client'
export type SourceGroup = { id: string; name: string; parentId: string | null }
export type GroupAncestor = { id: string; name: string }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function categoryMappings(config: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(object(config).categoryGroups)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
export function savedGroupTree(config: unknown): SourceGroup[] {
  const rows = object(config).catalogGroupTree
  return Array.isArray(rows) ? rows.filter((g): g is SourceGroup => !!g && typeof g.id === 'string' && typeof g.name === 'string' && (g.parentId === null || typeof g.parentId === 'string')) : []
}
const treeCache = new WeakMap<object, Map<string, SourceGroup>>()
/** Payload ancestry is authoritative; saved tree supplies classifier-free delta imports. */
export function sourceGroupPath(raw: Record<string, unknown>, config: unknown): GroupAncestor[] {
  const supplied = Array.isArray(raw.brandPath) ? raw.brandPath.filter((g): g is GroupAncestor => !!g && typeof g.id === 'string' && typeof g.name === 'string') : []
  if (supplied.length) return supplied
  const key = object(config)
  let tree = treeCache.get(key)
  if (!tree) { tree = new Map(savedGroupTree(config).map(g => [g.id,g])); treeCache.set(key,tree) }
  const path: GroupAncestor[] = [], seen = new Set<string>()
  let current: string | undefined = typeof raw.groupId === 'string' ? raw.groupId : undefined
  while (current && tree.has(current) && !seen.has(current)) {
    seen.add(current); const g = tree.get(current)!; path.push({ id: g.id, name: g.name }); current = g.parentId ?? undefined
  }
  if (!path.length && typeof raw.categoryExternalId === 'string') path.push({ id: raw.categoryExternalId, name: typeof raw.categoryName === 'string' ? raw.categoryName : raw.categoryExternalId })
  return path
}
export function mappedCategory(raw: Record<string, unknown>, config: unknown): string | undefined {
  const mappings = categoryMappings(config)
  for (const g of sourceGroupPath(raw, config)) if (mappings[g.id]) return mappings[g.id]
}
export async function resolveStoreCategory(tx: Prisma.TransactionClient, storeId: string, id: string): Promise<string> {
  const category = await tx.category.findFirstOrThrow({ where: { id, storeId }, select: { id: true, mergedIntoId: true } })
  if (!category.mergedIntoId) return category.id
  return (await tx.category.findFirstOrThrow({ where: { id: category.mergedIntoId, storeId, mergedIntoId: null }, select: { id: true } })).id
}

/** Persist ancestry observed during successful imports so later deltas need no repeated classifier. */
export async function rememberGroupPaths(tx: Prisma.TransactionClient, connectionId: string, config: Prisma.JsonValue, payloads: Record<string, unknown>[]): Promise<Prisma.JsonValue> {
  const tree = new Map(savedGroupTree(config).map(g=>[g.id,g]))
  let changed=false
  for(const raw of payloads) {
    const path=Array.isArray(raw.brandPath)?raw.brandPath.filter((g):g is GroupAncestor=>!!g&&typeof g.id==='string'&&typeof g.name==='string'):[]
    path.forEach((g,i)=>{const next={...g,parentId:path[i+1]?.id??null},old=tree.get(g.id);if(!old||old.name!==next.name||old.parentId!==next.parentId){tree.set(g.id,next);changed=true}})
  }
  if(!changed)return config
  const next={...(object(config) as Record<string,Prisma.InputJsonValue>),catalogGroupTree:Array.from(tree.values())}
  await tx.integrationConnection.update({where:{id:connectionId},data:{config:next}})
  return next
}
