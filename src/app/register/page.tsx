import type { Metadata } from 'next'
import { AuthForm } from '@/components/AuthForm'
import { StorefrontHeader } from '@/components/StorefrontHeader'
import { loadStoreProfile } from '@/lib/store-profile'

export function generateMetadata(): Metadata {
  const profile = loadStoreProfile()
  return {
    title: 'Стать партнёром',
    description: `Регистрация юридических лиц и индивидуальных предпринимателей в оптовом B2B-каталоге ${profile.identity.name}.`,
    alternates: { canonical: '/register' },
    openGraph: {
      title: `Стать партнёром ${profile.identity.name}`,
      description: 'Оставьте заявку на доступ к оптовому каталогу, персональным ценам и оформлению заказов.',
      url: '/register',
    },
  }
}

export default function RegisterPage() { return <><StorefrontHeader /><main className="auth-page"><AuthForm mode="register" /></main></> }
