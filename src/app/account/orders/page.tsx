import { AccountOrdersClient } from '@/components/AccountOrdersClient'
import { StorefrontHeader } from '@/components/StorefrontHeader'
import { requireActiveUserPage } from '@/lib/authz'

export default async function AccountOrdersPage() {
  await requireActiveUserPage()
  return <><StorefrontHeader /><AccountOrdersClient /></>
}
