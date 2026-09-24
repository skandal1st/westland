const FALLBACK_SITE_URL = 'https://westsidetobacco.ru'

export function getSiteUrl() {
  const configured = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXTAUTH_URL || FALLBACK_SITE_URL
  try {
    return new URL('/', configured)
  } catch {
    return new URL(FALLBACK_SITE_URL)
  }
}

export const storefrontDescription = 'Оптовый B2B-каталог Westside для юридических лиц: актуальный ассортимент, персональные цены, остатки, заказ и счёт в личном кабинете.'

export const privatePageMetadata = {
  robots: { index: false, follow: false, nocache: true },
} as const
