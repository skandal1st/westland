import { StorefrontHeader } from '@/components/StorefrontHeader'
import { CheckoutClient } from '@/components/CheckoutClient'
import { OrderDetailsClient } from '@/components/OrderDetailsClient'
import { requireActiveUserPage } from '@/lib/authz'
import { checkoutRecoveryKey } from '@/lib/cart/checkout-recovery'

export default async function CheckoutPage({ searchParams }: { searchParams: { order?: string | string[] } }) {
  const user = await requireActiveUserPage()
  const storageKey = checkoutRecoveryKey(user.storeId, user.id)
  const orderId = typeof searchParams.order === 'string' ? searchParams.order : null
  return <>
    <StorefrontHeader />
    {orderId ? <OrderDetailsClient key={orderId} orderId={orderId} storageKey={storageKey} /> : <CheckoutClient key={storageKey} storageKey={storageKey} />}
  </>
}
