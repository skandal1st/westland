import { prisma } from '@/lib/db'
export type CategoryNode = { id: string; parentId: string | null; name: string; slug: string; count: number; children: CategoryNode[] }
export type CategoryRow = { id: string; parentId: string | null; name: string; slug: string; hidden: boolean; mergedIntoId: string | null }
export function categoryForest(rows: CategoryRow[], counts: Map<string, number> = new Map(), includeEmpty = false): CategoryNode[] {
  const byId = new Map(rows.map(r => [r.id, r])), visible = new Map<string, boolean>()
  const allowed = (row: CategoryRow, seen = new Set<string>()): boolean => {
    if (visible.has(row.id)) return visible.get(row.id)!
    if (row.hidden || row.mergedIntoId || seen.has(row.id)) return false
    seen.add(row.id)
    const result = !row.parentId || (!!byId.get(row.parentId) && allowed(byId.get(row.parentId)!, seen))
    visible.set(row.id, result); return result
  }
  const nodes = new Map<string, CategoryNode>()
  for (const row of rows) if (allowed(row)) nodes.set(row.id, { id: row.id, parentId: row.parentId, name: row.name, slug: row.slug, count: counts.get(row.id) ?? 0, children: [] })
  const roots: CategoryNode[] = []
  for (const node of Array.from(nodes.values())) { const parent = node.parentId ? nodes.get(node.parentId) : undefined; if (parent) parent.children.push(node); else roots.push(node) }
  const collect = (node: CategoryNode): boolean => { node.children = node.children.filter(collect); node.count += node.children.reduce((n,c)=>n+c.count,0); return includeEmpty || node.count > 0 }
  return roots.filter(collect)
}
export function flattenCategories(tree: CategoryNode[]): CategoryNode[] { return tree.flatMap(n => [n, ...flattenCategories(n.children)]) }
export function categoryTrail(tree: CategoryNode[], slug: string): CategoryNode[] {
  for (const node of tree) { if (node.slug === slug) return [node]; const path = categoryTrail(node.children, slug); if (path.length) return [node, ...path] }
  return []
}
export async function categoryRows(storeId: string) { return prisma.category.findMany({ where: { storeId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id:true,parentId:true,name:true,slug:true,hidden:true,mergedIntoId:true } }) }
export async function categoryScope(storeId: string, slug?: string | null) {
  const tree = categoryForest(await categoryRows(storeId), new Map(), true)
  const trail = slug ? categoryTrail(tree, slug) : []
  return { tree, trail, ids: slug ? (trail.length ? flattenCategories([trail[trail.length-1]]).map(n=>n.id) : []) : flattenCategories(tree).map(n=>n.id) }
}

/** Includes self; shared by category-scoped commerce rules. */
export function categoryAncestry(rows: {id:string;parentId:string|null}[]) {
  const parents=new Map(rows.map(r=>[r.id,r.parentId])),cache=new Map<string,string[]>()
  return (id:string|null):string[]=>{
    if(!id)return []
    const cached=cache.get(id);if(cached)return cached
    const path:string[]=[],seen=new Set<string>();let next:string|null|undefined=id
    while(next&&!seen.has(next)){seen.add(next);path.push(next);next=parents.get(next)}
    cache.set(id,path);return path
  }
}
