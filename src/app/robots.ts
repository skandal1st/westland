import type { MetadataRoute } from 'next'
import { getSiteUrl } from '@/lib/seo'

export default function robots(): MetadataRoute.Robots {
  const siteUrl = getSiteUrl()
  return {
    rules: [{
      userAgent: '*',
      allow: ['/', '/register'],
      disallow: ['/api/', '/account', '/checkout', '/staff', '/login', '/catalog', '/brands'],
    }],
    sitemap: new URL('/sitemap.xml', siteUrl).href,
    host: siteUrl.origin,
  }
}
