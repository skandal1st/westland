import { CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireApiUser } from '@/lib/authz'
import { ContentError, updateProductContent } from '@/lib/catalog/content'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const schema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  slug: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9Ѐ-ӿ-]+$/, 'Некорректный slug').optional(),
  description: z.string().max(10_000).optional(),
  imageUrls: z.array(z.string().url()).optional(),
  seoTitle: z.string().nullable().optional(),
  seoDescription: z.string().nullable().optional(),
  attributes: z.record(z.string().max(500)).refine(value => Object.keys(value).length <= 30 && Object.keys(value).every(key => key.trim().length > 0 && key.length <= 80), 'Некорректные характеристики').optional(),
})

export async function PUT(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireApiUser(['STAFF', 'ADMIN'], 'content')
  if ('response' in auth) return auth.response

  const body = await request.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'invalid_input', issues: parsed.error.flatten() }, { status: 400 })

  try {
    const updated = await updateProductContent(params.id, parsed.data, { actor: auth.user })
    return NextResponse.json({ content: { displayName: updated.displayName, slug: updated.slug, description: updated.description, attributes: updated.attributes } })
  } catch (error) {
    if (error instanceof LicenseError || error instanceof CapabilityError) return NextResponse.json({ error: error.message }, { status: 403 })
    if (error instanceof ContentError) {
      return NextResponse.json({ error: error.code }, { status: error.code === 'NOT_FOUND' ? 404 : 409 })
    }
    throw error
  }
}
