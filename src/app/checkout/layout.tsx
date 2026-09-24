import type { Metadata } from 'next'
import { privatePageMetadata } from '@/lib/seo'

export const metadata: Metadata = { title: 'Оформление заказа', ...privatePageMetadata }

export default function CheckoutLayout({ children }: Readonly<{ children: React.ReactNode }>) { return children }
