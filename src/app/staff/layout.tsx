import type { Metadata } from 'next'
import { privatePageMetadata } from '@/lib/seo'

export const metadata: Metadata = { title: 'Бек-офис', ...privatePageMetadata }

export default function StaffLayout({ children }: Readonly<{ children: React.ReactNode }>) { return children }
