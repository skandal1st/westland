import { NextResponse } from 'next/server'
import { requireApiUser } from '@/lib/authz'
import { getLicenseState, isLicenseEnforced } from '@/lib/license'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** License status for the backoffice (validated offline, no secrets exposed). */
export async function GET() {
  const auth = await requireApiUser(['STAFF', 'ADMIN'])
  if ('response' in auth) return auth.response
  const state = getLicenseState()
  return NextResponse.json({
    status: state.status,
    enforced: isLicenseEnforced(),
    reason: state.reason ?? null,
    licenseId: state.licenseId ?? null,
    customerId: state.customerId ?? null,
    installationId: state.installationId ?? null,
    deploymentClass: state.deploymentClass ?? null,
    modules: state.modules,
  })
}
