export type ExternalProduct = {
  externalId: string
  sku: string
  name: string
  categoryExternalId?: string
  brandExternalId?: string
  stockByLocation: Record<string, number>
  sourceUpdatedAt: Date
  raw?: unknown
}

export type ExportOrder = {
  id: string
  number: string
  customer: { id: string; inn: string; legalName: string }
  deliveryPoint: { id: string; name: string; city: string; address: string }
  fulfillment: {
    channelCode: string
    inventoryLocationCode: string
    paymentMethod: 'BANK_TRANSFER' | 'CASH'
  }
  items: Array<{ sku: string; quantity: number; unitPrice: number }>
  total: number
  createdAt: Date
}

export interface CatalogImportPort {
  pullProducts(cursor?: string): Promise<{ items: ExternalProduct[]; nextCursor?: string }>
}

export interface OrderExportPort {
  exportOrder(order: ExportOrder): Promise<{ externalId: string; acceptedAt: Date }>
}

export interface CommerceConnector extends CatalogImportPort, OrderExportPort {
  readonly provider: 'ONE_C' | 'MOYSKLAD' | 'CUSTOM'
  healthcheck(): Promise<{ ok: boolean; message?: string }>
}
