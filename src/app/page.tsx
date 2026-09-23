import { StoreBanners } from '@/components/StoreBanners'
import { getActiveBanners } from '@/lib/content/read'
import { getActiveStore } from '@/lib/store'
import Link from 'next/link'
import { ArrowRight, FileText, LockKeyhole, PackageSearch } from 'lucide-react'
import { StorefrontHeader } from '@/components/StorefrontHeader'
import { loadStoreProfile } from '@/lib/store-profile'

export const dynamic = 'force-dynamic'
export default async function HomePage() {
  const profile = loadStoreProfile()
  const store = await getActiveStore()
  const banners = profile.modules.content ? await getActiveBanners({ storeId: store.id, placement: 'HOME' }) : []
  return <><StorefrontHeader />{banners.length ? <div className="home-banners"><StoreBanners banners={banners} /></div> : null}<main className="access-page"><section className="access-copy"><h1>Оптовый каталог для партнёров {profile.identity.name}</h1><p>Товары, персональные цены и остатки доступны только зарегистрированным юридическим лицам.</p><div className="access-actions"><Link className="button button-primary" href="/login">Войти в каталог <ArrowRight /></Link><Link className="button button-secondary" href="/register">Стать партнёром</Link></div></section><section className="access-panel"><div className="access-icon"><LockKeyhole /></div><h2>Закрытая витрина</h2><p>Для доступа войдите или отправьте заявку на регистрацию компании.</p><div className="access-steps"><div><PackageSearch /><span><b>1. Выберите товары</b><small>Поиск и простой каталог</small></span></div><div><FileText /><span><b>2. Получите счёт</b><small>PDF формируется магазином</small></span></div></div></section></main></>
}

