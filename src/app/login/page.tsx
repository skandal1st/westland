import type { Metadata } from 'next'
import { AuthForm } from '@/components/AuthForm'
import { StorefrontHeader } from '@/components/StorefrontHeader'
import { privatePageMetadata } from '@/lib/seo'

export const metadata: Metadata = { title: 'Вход для партнёров', ...privatePageMetadata }

export default function LoginPage() { return <><StorefrontHeader /><main className="auth-page"><AuthForm mode="login" /></main></> }
