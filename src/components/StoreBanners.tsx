/* eslint-disable @next/next/no-img-element -- Supports the administrator's independent mobile and desktop assets. */
import { safeBannerHref } from '@/lib/content/banner-link'
export type StorefrontBanner = { id: string; name: string; desktopImageUrl: string | null; mobileImageUrl: string | null; linkUrl: string | null; category?: { slug: string; name: string } | null; brand: { slug: string; name: string } | null }
export function StoreBanners({ banners }: { banners: StorefrontBanner[] }) {
  return <div className="store-banners" aria-label="Акции магазина">{banners.map(banner => {
    const href = safeBannerHref(banner.linkUrl) || (banner.category ? '/catalog?category=' + encodeURIComponent(banner.category.slug) : banner.brand ? '/brands/' + encodeURIComponent(banner.brand.slug) : null)
    const body = banner.desktopImageUrl ? <picture>{banner.mobileImageUrl ? <source media="(max-width: 700px)" srcSet={banner.mobileImageUrl} /> : null}<img src={banner.desktopImageUrl} alt={banner.name} /></picture> : <div className="catalog-banner"><strong>{banner.name}</strong></div>
    return href ? <a className="store-banner" key={banner.id} href={href}>{body}</a> : <section className="store-banner" key={banner.id} aria-label={banner.name}>{body}</section>
  })}</div>
}
