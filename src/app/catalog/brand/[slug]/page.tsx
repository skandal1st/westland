import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { StorefrontHeader } from '@/components/StorefrontHeader'
import { requireActiveUserPage } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { loadStoreProfile } from '@/lib/store-profile'
import { getBrandPage } from '@/lib/content/read'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Managed brand landing page (hero + rich body) driven by the BrandPage overlay. */
export default async function BrandLandingPage({ params }: { params: { slug: string } }) {
  if (loadStoreProfile().policies.catalogRequiresAuth) await requireActiveUserPage()
  const store = await getActiveStore()
  const page = await getBrandPage({ storeId: store.id, slug: params.slug })
  if (!page) notFound()

  const paragraphs = typeof page.body === 'string' ? page.body.split('\n').filter(Boolean) : []

  return (
    <>
      <StorefrontHeader />
      <main className="catalog-page">
        <Link className="button button-secondary" href="/catalog" style={{ alignSelf: 'flex-start' }}><ArrowLeft /> К каталогу</Link>
        <section
          className="catalog-banner"
          style={{ background: page.heroImageUrl ? `center/cover url(${page.heroImageUrl})` : '#25242a', color: '#fff' }}
          aria-label={`Бренд ${page.brand.name}`}
        >
          <div><strong>{page.brand.name}</strong><span>{page.title}</span></div>
        </section>
        {paragraphs.length > 0 ? (
          <section className="access-copy">{paragraphs.map((text, i) => <p key={i}>{text}</p>)}</section>
        ) : null}
      </main>
    </>
  )
}
