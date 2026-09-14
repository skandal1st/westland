import { StaffDashboard } from '@/components/StaffDashboard'
import { requireStaffPage } from '@/lib/authz'

export default async function StaffPage() {
  await requireStaffPage()
  return <StaffDashboard />
}
