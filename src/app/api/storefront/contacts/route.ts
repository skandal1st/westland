import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getActiveStore } from '@/lib/store'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Public business contacts only; never serialize seller or bank requisites. */
export async function GET() {
  const store = await getActiveStore()
  const settings = await prisma.appSettings.findUnique({ where: { storeId: store.id }, select: { sellerRequisites: true } })
  const raw = settings?.sellerRequisites
  const requisites = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const phone = typeof requisites.phone === 'string' && /^[+\d\s().-]{7,40}$/.test(requisites.phone.trim()) ? requisites.phone.trim() : null
  const email = typeof requisites.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requisites.email) && requisites.email.length <= 254 ? requisites.email : null
  return NextResponse.json({ phone, email })
}
