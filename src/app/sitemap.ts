import type { MetadataRoute } from 'next'
import { getSiteUrl } from '@/lib/seo'

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl()
  return [
    { url: siteUrl.href, changeFrequency: 'weekly', priority: 1 },
    { url: new URL('/register', siteUrl).href, changeFrequency: 'monthly', priority: 0.7 },
  ]
}
