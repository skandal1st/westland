import type { Metadata } from 'next'
import { AgeGate } from '@/components/AgeGate'
import { CartDrawer } from '@/components/CartDrawer'
import './globals.css'

export const metadata: Metadata = { title: 'Westside — оптовый каталог', description: 'Закрытый B2B-каталог Westside' }

const paletteScript = `(function(){try{var value=localStorage.getItem('westside-palette');if(value)document.documentElement.dataset.palette=value}catch(error){}})()`

const contract = `<!--
THESIS: Максимально простой закрытый B2B-каталог; отказываемся от сложных метафор и декоративных панелей.
OWN-WORLD: Белый рабочий фон, насыщенная фиолетовая шапка, бирюзовое выбранное состояние, прямые светлые поверхности.
STORY: Партнёр подтверждает возраст, проходит модерацию, выбирает оплату и склад, собирает заказ для своей точки и при безналичной оплате получает PDF-счёт.
FIRST VIEWPORT: Крупная шапка с каталогом и поиском; ниже брендовый баннер, выбор оплаты, фильтры и плотный список товаров; корзина доступна из шапки.
FORM: Утилитарная витрина по утверждённому референсу; canon; seed eae1a262.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru" data-palette="violet" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: paletteScript }} /></head><body><span className="design-contract" dangerouslySetInnerHTML={{ __html: contract }} />{children}<AgeGate /><CartDrawer /></body></html>
}
