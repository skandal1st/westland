import type { Metadata } from 'next'
import { AgeGate } from '@/components/AgeGate'
import { CartDrawer } from '@/components/CartDrawer'
import { Providers } from '@/components/Providers'
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
  }
}

const contract = `<!--
THESIS: Максимально простой закрытый B2B-каталог; отказываемся от сложных метафор и декоративных панелей.
OWN-WORLD: Белый рабочий фон, насыщенная фиолетовая шапка, бирюзовое выбранное состояние, прямые светлые поверхности.
STORY: Партнёр подтверждает возраст, проходит модерацию, выбирает оплату и склад, собирает заказ для своей точки и при безналичной оплате получает PDF-счёт.
FIRST VIEWPORT: Крупная шапка с каталогом и поиском; ниже брендовый баннер, выбор оплаты, фильтры и плотный список товаров; корзина доступна из шапки.
FORM: Утилитарная витрина по утверждённому референсу; canon; seed eae1a262.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const profile = toPublicProfile(loadStoreProfile())
  const paletteKey = `${profile.storageNamespace}-palette`
  const paletteScript = `(function(){try{var k=${JSON.stringify(paletteKey)};var value=localStorage.getItem(k);if(value)document.documentElement.dataset.palette=value}catch(error){}})()`
  return (
    <html lang="ru" data-palette={profile.theme.defaultPalette} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: paletteScript }} /></head>
      <body>
        <span className="design-contract" dangerouslySetInnerHTML={{ __html: contract }} />
        <Providers profile={profile}>
          {children}
          <AgeGate />
          <CartDrawer />
        </Providers>
      </body>
    </html>
  )
}
