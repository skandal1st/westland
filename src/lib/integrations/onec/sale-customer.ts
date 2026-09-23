import type { Prisma } from '@prisma/client'
import type { CommercialSnapshot } from '@/lib/orders/commercial-snapshot'
import { ExchangeError, sha256 } from './storage'

/** Called under the source lock in querySales. This is an XML identity, not an ERP ID. */
export async function saleCustomerIdentity(tx: Prisma.TransactionClient, terms: CommercialSnapshot, connectionId: string) {
  const buyer = terms.buyer
  if (!await tx.customer.findFirst({ where: { id: buyer.id, storeId: terms.storeId }, select: { id: true } })) {
    throw new ExchangeError('sale_customer_not_found')
  }
  const mappings = await tx.externalReference.findMany({ where: { connectionId, entityType: 'customer', entityId: buyer.id } })
  if (mappings.length > 1) throw new ExchangeError('sale_customer_mapping_ambiguous')
  const previous = await tx.onecSaleCustomerIdentity.findUnique({ where: { connectionId_customerId: { connectionId, customerId: buyer.id } } })
  if (previous) {
    if (previous.inn !== buyer.inn || previous.kpp !== buyer.kpp) throw new ExchangeError('sale_customer_requisites_changed')
    if (mappings[0] && mappings[0].externalId !== previous.xmlId) throw new ExchangeError('sale_customer_identity_changed')
    return previous.xmlId
  }
  // Source-scoped and deterministic, including across a failed transaction or restore.
  // Do not store this website ID as a verified customer ExternalReference.
  const xmlId = mappings[0]?.externalId ?? 'site-' + sha256(JSON.stringify([terms.storeId, connectionId, buyer.id])).slice(0, 32)
  await tx.onecSaleCustomerIdentity.create({ data: {
    connectionId, customerId: buyer.id, xmlId, origin: mappings.length ? 'ERP_MAPPING' : 'WEBSITE', inn: buyer.inn, kpp: buyer.kpp,
  } })
  return xmlId
}
