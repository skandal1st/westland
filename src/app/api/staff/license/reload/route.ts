import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiUser } from '@/lib/authz'
import { getActiveStore } from '@/lib/store'
import { reloadLicenseState } from '@/lib/license'
import { AuditAction, recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Re-read the license grant from disk after a reactivation, restore or
 * migration. Activation itself happens at deploy time (install.mjs); this only
 * refreshes the runtime view of the on-disk grant. Recorded to audit.
 */
export async function POST() {
  const auth = await requireApiUser(['ADMIN'])
  if ('response' in auth) return auth.response
  const store = await getActiveStore()

  const state = reloadLicenseState()
  await recordAudit(prisma, {
    storeId: store.id, actor: auth.user, action: AuditAction.LicenseReactivated,
    targetType: 'License', targetId: state.licenseId ?? 'unknown', summary: `License reloaded → ${state.status}`,
  })
  return NextResponse.json({ status: state.status, reason: state.reason ?? null })
}
