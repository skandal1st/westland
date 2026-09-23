import { describe, expect, it } from 'vitest'
import { safeBannerHref } from '@/lib/content/banner-link'

describe('banner href allowlist', () => {
  it.each(['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', '\tjavascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', '\u0000https://example.com', 'https://example.com\u007f', 'https://example.com/a b', ' //example.com', '//example.com', '/\\example.com', '\\example.com', 'http:example.com', 'https:/example.com', 'https://', 'file:///tmp/a', ' https://example.com', 'https://example.com ', ''])('rejects unsafe or ambiguous input: %j', (href) => {
    expect(safeBannerHref(href)).toBeNull()
  })
  it.each(['/catalog?brand=x', '/catalog/brand/test#offers', 'catalog?x=1', '../catalog', '?brand=x', '#offers', 'https://example.com/a%20b?q=1&b=2', 'http://example.com/', 'HTTPS://EXAMPLE.COM/a', '/каталог'])('preserves legitimate navigation: %s', (href) => {
    expect(safeBannerHref(href)).toBe(href)
  })
  it('preserves absent links as noninteractive content', () => {
    expect(safeBannerHref(null)).toBeNull()
    expect(safeBannerHref(undefined)).toBeNull()
  })
})
