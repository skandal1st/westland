/* eslint-disable @next/next/no-img-element -- Uploaded brand and campaign assets are served from validated application endpoints. */
import Link from 'next/link'
import type { Metadata } from 'next'
import { ArrowRight, PackageCheck } from 'lucide-react'
import { StorefrontHeader } from '@/components/StorefrontHeader'
import { StoreBanners } from '@/components/StoreBanners'
import { getActiveBanners } from '@/lib/content/read'
import { parseHomeCompanyBlock, safeHomeCtaHref, HOME_COMPANY_BLOCK_KEY } from '@/lib/content/home'
import { StoreRequisitesInputSchema } from '@/lib/invoices/requisites'
import { prisma } from '@/lib/db'
import { getActiveStore } from '@/lib/store'
import { getSiteUrl, storefrontDescription } from '@/lib/seo'
import { loadStoreProfile } from '@/lib/store-profile'

export function generateMetadata(): Metadata {
  const profile = loadStoreProfile()
  return {
    title: { absolute: `${profile.identity.name} — оптовый B2B-каталог для бизнеса` },
    description: storefrontDescription,
    alternates: { canonical: '/' },
  }
}

export const dynamic = 'force-dynamic'

function offerLine(rule: unknown) {
  if (!rule || typeof rule !== 'object') return 'Специальные условия для партнёров'
  const value = rule as { minQty?: unknown; rewardQty?: unknown }
  const min = typeof value.minQty === 'number' ? value.minQty : null
  const reward = typeof value.rewardQty === 'number' ? value.rewardQty : null
  return min && reward ? `За каждые ${min} шт. — ${reward} шт. в подарок` : 'Специальные условия для партнёров'
}

export default async function HomePage() {
  const profile = loadStoreProfile()
  const store = await getActiveStore()
  const siteUrl = getSiteUrl()
  const now = new Date()
  const [banners, promotions, brands, block, settings] = await Promise.all([
    profile.modules.content ? getActiveBanners({ storeId: store.id, placement: 'HOME', date: now }) : Promise.resolve([]),
    profile.modules.promotions ? prisma.giftPromotion.findMany({
      where: { storeId: store.id, isActive: true, showOnHome: true, AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, homeDescription: true, homeImageUrl: true, rule: true },
    }) : Promise.resolve([]),
    prisma.brand.findMany({
      where: { storeId: store.id, logoUrl: { not: null }, products: { some: { status: 'ACTIVE' } } },
      orderBy: { name: 'asc' }, take: 18,
      select: { id: true, name: true, slug: true, logoUrl: true },
    }),
    profile.modules.content ? prisma.contentBlock.findUnique({ where: { storeId_key: { storeId: store.id, key: HOME_COMPANY_BLOCK_KEY } }, select: { title: true, body: true, isActive: true } }) : Promise.resolve(null),
    prisma.appSettings.findUnique({ where: { storeId: store.id }, select: { sellerRequisites: true } }),
  ])
  const company = block?.isActive ? parseHomeCompanyBlock(block.title, block.body) : null
  const companyHref = company?.ctaHref ? safeHomeCtaHref(company.ctaHref) : null
  const parsedRequisites = StoreRequisitesInputSchema.safeParse(settings?.sellerRequisites ?? {})
  const requisites = parsedRequisites.success ? parsedRequisites.data : {}
  const structuredData = [
    {
      '@context': 'https://schema.org', '@type': 'Organization', '@id': `${siteUrl.href}#organization`,
      name: profile.identity.name, legalName: requisites.companyName || profile.identity.legalName || profile.identity.name,
      url: siteUrl.href, logo: new URL('/brand/westside-logo.png', siteUrl).href,
      ...(requisites.inn ? { taxID: requisites.inn } : {}),
      ...(requisites.ogrn ? { identifier: { '@type': 'PropertyValue', propertyID: 'ОГРН', value: requisites.ogrn } } : {}),
    },
    {
      '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${siteUrl.href}#website`,
      name: profile.identity.name, url: siteUrl.href, inLanguage: 'ru-RU',
      publisher: { '@id': `${siteUrl.href}#organization` },
    },
  ]

  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }} />
    <StorefrontHeader />
    <main className="home-page">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero-media" aria-hidden="true" />
        <div className="home-hero-shade" aria-hidden="true" />
        <div className="home-hero-copy">
          <img className="home-hero-logo" src="/brand/westside-logo.png" alt="" />
          <h1 id="home-title">Оптовый каталог<br />для вашего бизнеса</h1>
          <p>Актуальный ассортимент, персональные цены и остатки для зарегистрированных юридических лиц.</p>
          <div className="home-hero-actions">
            <Link className="button home-button-light" href="/login">Войти в каталог <ArrowRight size={18} /></Link>
            <Link className="button home-button-ghost" href="/register">Стать партнёром</Link>
          </div>
          <span className="home-hero-note"><PackageCheck size={18} /> Заказ и счёт — в одном личном кабинете</span>
        </div>
      </section>

      {promotions.length || banners.length ? <section className="home-section home-promotions" aria-labelledby="promotions-title">
        <div className="home-section-heading"><h2 id="promotions-title">Актуальные предложения</h2><p>Специальные условия для оптовых покупателей</p></div>
        {promotions.length ? <div className="home-promo-grid">{promotions.map(promotion => <article className={'home-promo-card' + (!promotion.homeImageUrl ? ' home-promo-card-graphic' : '')} key={promotion.id}>
          {promotion.homeImageUrl ? <img src={promotion.homeImageUrl} alt="" /> : null}
          <div className="home-promo-scrim" aria-hidden="true" />
          <div className="home-promo-copy"><span>Акция</span><h3>{promotion.name}</h3><p>{promotion.homeDescription || offerLine(promotion.rule)}</p></div>
        </article>)}</div> : null}
        {banners.length ? <div className="home-editorial-banners"><StoreBanners banners={banners} /></div> : null}
      </section> : null}

      {brands.length ? <section className="home-section home-brands" aria-labelledby="brands-title">
        <div className="home-section-heading"><h2 id="brands-title">Бренды в каталоге</h2><Link href="/catalog">Смотреть весь каталог <ArrowRight size={17} /></Link></div>
        <div className="home-brand-list">{brands.map(brand => <Link href={'/brands/' + encodeURIComponent(brand.slug)} className="home-brand" key={brand.id}><img src={brand.logoUrl!} alt={brand.name} /><span>{brand.name}</span></Link>)}</div>
      </section> : null}

      {company ? <section className="home-company" aria-labelledby="company-title">
        <h2 id="company-title">{company.title}</h2>
        <p>{company.text}</p>
        {company.ctaLabel && companyHref ? <Link className="button button-primary" href={companyHref}>{company.ctaLabel}<ArrowRight size={18} /></Link> : null}
      </section> : null}
    </main>
  </>
}
