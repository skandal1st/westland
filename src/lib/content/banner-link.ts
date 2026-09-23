/** Shared write/render allowlist. Return the original URL, never repair unsafe input. */
export function safeBannerHref(value: string | null | undefined): string | null {
  if (!value || value !== value.trim() || /[\u0000-\u0020\u007f-\u009f\\]/.test(value) || value.startsWith('//')) return null
  try {
    const base = 'https://banner.invalid'
    const url = new URL(value, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    // An explicit scheme must be a full HTTP(S) URL. Relative links stay local.
    if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
      return /^https?:\/\//i.test(value) ? value : null
    }
    return url.origin === base ? value : null
  } catch {
    return null
  }
}
