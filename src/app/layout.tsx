import type { Metadata } from 'next'
import { AgeGate } from '@/components/AgeGate'
import { CartDrawer } from '@/components/CartDrawer'
import { CookieNotice } from '@/components/CookieNotice'
import { Providers } from '@/components/Providers'
import { SiteFooter } from '@/components/SiteFooter'
import { prisma } from '@/lib/db'
import { StoreRequisitesInputSchema } from '@/lib/invoices/requisites'
import { resolvePalette } from '@/lib/palette'
import { loadStoreProfile, toPublicProfile } from '@/lib/store-profile'
import './globals.css'

// Branding/policies come from the deployment profile, which is read at runtime.
// A closed B2B storefront is personalized anyway, so per-request rendering is
// correct here and guarantees the profile reflects the actual deployment.
export const dynamic = 'force-dynamic'

export function generateMetadata(): Metadata {
  const profile = loadStoreProfile()
  return {
    title: `${profile.identity.name} — оптовый каталог`,
    description: `Закрытый B2B-каталог ${profile.identity.name}`,
    icons: {
      icon: '/icon.png',
      apple: '/apple-icon.png',
    },
  }
}

const contract = `<!--
THESIS: Максимально простой закрытый B2B-каталог; отказываемся от сложных метафор и декоративных панелей.
OWN-WORLD: Белый рабочий фон, графитовая шапка по умолчанию, зелёное выбранное состояние, прямые светлые поверхности; альтернативные схемы доступны в настройках бекофиса.
STORY: Партнёр подтверждает возраст, проходит модерацию, выбирает оплату и склад, собирает заказ для своей точки и при безналичной оплате получает PDF-счёт.
FIRST VIEWPORT: Крупная шапка с каталогом и поиском; ниже брендовый баннер, выбор оплаты, фильтры и плотный список товаров; корзина доступна из шапки.
FORM: Утилитарная витрина по утверждённому референсу; canon; seed eae1a262.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const storeProfile = loadStoreProfile()
  const store = await prisma.store.findUnique({
    where: { slug: storeProfile.identity.code },
    select: { settings: { select: { palette: true, sellerRequisites: true } } },
  })
  const defaultPalette = resolvePalette(store?.settings?.palette, resolvePalette(storeProfile.theme.defaultPalette))
  const profile = toPublicProfile({ ...storeProfile, theme: { ...storeProfile.theme, defaultPalette } })
  const parsedRequisites = StoreRequisitesInputSchema.safeParse(store?.settings?.sellerRequisites ?? {})
  const requisites = parsedRequisites.success ? parsedRequisites.data : {}
  return (
    <html lang="ru" data-palette={profile.theme.defaultPalette} suppressHydrationWarning>
      <body>
        <span className="design-contract" dangerouslySetInnerHTML={{ __html: contract }} />
        <Providers profile={profile}>
          {children}
          <AgeGate />
          <CartDrawer />
        </Providers>
        <SiteFooter storeName={profile.identity.name} requisites={requisites} />
        <CookieNotice />
      </body>
    </html>
  )
}
