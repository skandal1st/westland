import { categoryForest, flattenCategories } from '@/lib/catalog/tree'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { slugify } from '@/lib/catalog/import'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Categories for backoffice management: name, visibility, order, product count. */
export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const categories = await prisma.category.findMany({
    where: { storeId: store.id, mergedIntoId: null },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, parentId: true, name: true, slug: true, hidden: true, sortOrder: true, _count: { select: { products: true } } },
  })

  const tree = categoryForest(categories.map(c=>({...c,hidden:false,mergedIntoId:null})),new Map(categories.map(c=>[c.id,c._count.products])),true)
  const totals = new Map(flattenCategories(tree).map(c=>[c.id,c.count]))
  return NextResponse.json({
    categories: categories.map((c) => ({ id: c.id, parentId: c.parentId, name: c.name, slug: c.slug, hidden: c.hidden, sortOrder: c.sortOrder, products: totals.get(c.id) ?? c._count.products })),
  })
}

const createSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict()
export async function POST(request: Request) {
  const auth = await requireApiUser(['ADMIN'], 'commerce-core'); if ('response' in auth) return auth.response
  const parsed = createSchema.safeParse(await request.json().catch(() => null)); if (!parsed.success) return NextResponse.json({ error: 'invalid_name' }, { status: 400 })
  const store = await getActiveStore()
  const category = await prisma.$transaction(async tx => {
    const base = slugify(parsed.data.name) || 'category'
    const exists = await tx.category.findUnique({ where: { storeId_slug: { storeId: store.id, slug: base } } })
    const result = await tx.category.create({ data: { storeId: store.id, name: parsed.data.name, slug: exists ? base + '-' + randomUUID().slice(0,8) : base } })
    await tx.auditEntry.create({ data: { storeId: store.id, actorId: auth.user.id, action: 'SiteCategoryCreated', targetType: 'Category', targetId: result.id, metadata: { name: result.name } } })
    return result
  })
  return NextResponse.json({ category }, { status: 201 })
}
