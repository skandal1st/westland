import { savedGroupTree } from '@/lib/catalog/group-mapping'
import { prisma } from '@/lib/db'
import { parseCatalog } from '@/lib/integrations/onec/commerceml'
import { latestGeneration } from './ledger'
import { readGenerationFile, type GenerationFile, type UploadFile } from './storage'

export type CatalogFileStats = { file: string; bytes: number; mtime: string; products: number; groups: number; offers: number; prices: number; stock: number }
async function completedFiles(connectionId: string, kind?: 'catalog' | 'offers') {
  const generation = await latestGeneration(connectionId)
  if (!generation) return []
  const files = (generation.files as unknown as GenerationFile[]).filter(file => kind ? file.kind === kind : file.kind !== 'asset')
  return Promise.all(files.map(async file => ({ ...file, at: generation.createdAt.toISOString(), xml: await readGenerationFile(connectionId, file) })))
}
export async function readStatus(connectionId: string) {
  const session = await prisma.onecExchangeSession.findFirst({ where: { connectionId }, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true, initializedAt: true, updatedAt: true, closedAt: true, files: true } })
  const generation = await latestGeneration(connectionId)
  const files = (session?.files ?? []) as unknown as UploadFile[]
  return { updatedAt: session?.updatedAt.toISOString(), lastCheckAuthAt: session?.createdAt.toISOString(),
    lastInitAt: session?.initializedAt?.toISOString(), lastImportAt: generation?.createdAt.toISOString(), generationId: generation?.id ?? null,
    session: session ? { id: session.id, startedAt: session.createdAt.toISOString(), files: files.map(file => ({ name: file.name, bytes: file.size, at: file.sealedAt ?? session.updatedAt.toISOString() })) } : undefined,
    catalog: await scanCatalog(connectionId), events: [] }
}

function count(haystack: string, needle: string): number {
  let n = 0
  let i = haystack.indexOf(needle)
  while (i !== -1) { n += 1; i = haystack.indexOf(needle, i + needle.length) }
  return n
}

/** Count element occurrences whose numeric value is > 0 (e.g. ЦенаЗаЕдиницу). */
function countPositive(haystack: string, re: RegExp): number {
  let n = 0
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(haystack)) !== null) {
    if (parseFloat((m[1] || '').replace(',', '.')) > 0) n += 1
  }
  return n
}

export type GroupNode = { externalId: string; name: string; path: string[]; depth: number; used: boolean; parentId: string | null }

/**
 * Full 1C group tree from the catalog files, for the brand-marking panel. Each
 * node carries its ancestor path (to disambiguate same-named folders) and
 * whether any product lives in it or its subtree (the mappable ones).
 */
export async function scanGroups(connectionId: string): Promise<GroupNode[]> {
  // A credential/config revision invalidates import authority, not the already synced catalog.
  // Prices-only generations also must not hide the last published category tree.
  // This is a read-only metadata lookup; requireGeneration still guards all imports.
  const source = await prisma.integrationConnection.findUnique({ where: { id: connectionId }, select: { enabled: true, sourceState: true, config: true } })
  if (!source?.enabled || source.sourceState !== 'ACTIVE') return []
  const generation = await prisma.onecGeneration.findFirst({
    where: { connectionId, files: { array_contains: [{ kind: 'catalog' }] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { files: true },
  })
  const files = await Promise.all(((generation?.files ?? []) as unknown as GenerationFile[])
    .filter(file => file.kind === 'catalog')
    .map(async file => ({ xml: await readGenerationFile(connectionId, file) })))
  const groups = new Map<string, { name: string; parentId: string | null }>(savedGroupTree(source.config).map(g => [g.id, g]))
  const refs = await prisma.$queryRaw<Array<{ groupId: string }>>`SELECT DISTINCT "sourceData"->>'groupId' AS "groupId" FROM "ExternalReference" WHERE "connectionId" = ${connectionId} AND "entityType" = 'product' AND "sourceData"->>'groupId' IS NOT NULL`
  const leaves = new Set<string>(refs.map(r => r.groupId))
  for (const { xml } of files) {
    const { groups: g } = parseCatalog(xml, (p) => { if (p.groupId) leaves.add(p.groupId) })
    g.forEach((v, k) => groups.set(k, v))
  }
  // Mark every group that is an ancestor (or the leaf) of some product.
  const used = new Set<string>()
  for (const leaf of Array.from(leaves)) {
    let cur: string | null | undefined = leaf
    const seen = new Set<string>()
    while (cur && groups.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      used.add(cur)
      cur = groups.get(cur)!.parentId
    }
  }
  const pathOf = (id: string): string[] => {
    const out: string[] = []
    let cur: string | null | undefined = id
    const seen = new Set<string>()
    while (cur && groups.has(cur) && !seen.has(cur)) {
      seen.add(cur)
      out.unshift(groups.get(cur)!.name)
      cur = groups.get(cur)!.parentId
    }
    return out
  }
  return Array.from(groups.entries())
    .map(([externalId, g]) => {
      const p = pathOf(externalId)
      return { externalId, name: g.name, path: p, depth: p.length, used: used.has(externalId), parentId: g.parentId }
    })
    .filter((n) => n.used) // only groups that actually contain products are mappable
    .sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')))
}

export type WarehouseStat = { id: string; total: number; positions: number }

/** Aggregate per-warehouse stock from offers files (offers give GUIDs, no names). */
export async function scanWarehouses(connectionId: string): Promise<WarehouseStat[]> {
  const files = await completedFiles(connectionId, 'offers')
  const map = new Map<string, { total: number; positions: number }>()
  for (const { xml } of files) {
    const re = /<Склады ИдСклада="([^"]+)" КоличествоНаСкладе="([^"]*)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(xml)) !== null) {
      const qty = Number((m[2] || '').replace(',', '.')) || 0
      const cur = map.get(m[1]) ?? { total: 0, positions: 0 }
      cur.total += qty
      if (qty > 0) cur.positions += 1
      map.set(m[1], cur)
    }
  }
  return Array.from(map.entries())
    .map(([id, v]) => ({ id, total: v.total, positions: v.positions }))
    .sort((a, b) => b.total - a.total)
}

/** Scan received catalog files for the counts the backoffice cares about. */
export async function scanCatalog(connectionId: string): Promise<CatalogFileStats[]> {
  return (await completedFiles(connectionId)).map(file => ({
    file: file.name, bytes: file.size, mtime: file.at,
    products: count(file.xml, '<Товар>'), groups: count(file.xml, '<Группа>'), offers: count(file.xml, '<Предложение>'),
    prices: countPositive(file.xml, /<ЦенаЗаЕдиницу>([^<]*)<\/ЦенаЗаЕдиницу>/g),
    stock: countPositive(file.xml, /<Количество>([^<]*)<\/Количество>/g),
  }))
}
