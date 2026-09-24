import type { Metadata } from 'next'
import { privatePageMetadata } from '@/lib/seo'

export const metadata: Metadata = { title: 'Закрытый каталог', ...privatePageMetadata }

export default function CatalogLayout({ children }: Readonly<{ children: React.ReactNode }>) { return children }
