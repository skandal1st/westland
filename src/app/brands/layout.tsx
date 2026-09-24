import type { Metadata } from 'next'
import { privatePageMetadata } from '@/lib/seo'

export const metadata: Metadata = { title: 'Бренд', ...privatePageMetadata }

export default function BrandsLayout({ children }: Readonly<{ children: React.ReactNode }>) { return children }
