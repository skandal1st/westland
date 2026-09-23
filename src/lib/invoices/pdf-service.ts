import type { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { getMediaStore } from '@/lib/media'
import { renderInvoicePdf } from '@/lib/invoices/pdf'
import type { InvoiceWithLines } from '@/lib/invoices/invoices'

/** Media key for an invoice's rendered PDF — version-scoped so a reissue can't serve a stale file. */
export function invoicePdfKey(invoice: { id: string; version: number }): string {
  return `invoices/${invoice.id}-v${invoice.version}.pdf`
}

// Share a cold-cache render among requests for the same immutable invoice version.
const generating = new Map<string, Promise<Buffer>>()

/** The private filesystem is a cache; a lost PDF is rebuilt from the invoice snapshot. */
export async function getInvoicePdf(invoice: InvoiceWithLines, client: PrismaClient = defaultPrisma): Promise<Buffer> {
  const media = getMediaStore()
  const key = invoicePdfKey(invoice)
  const cached = await media.get(key)
  if (cached) return cached
  const pending = generating.get(key)
  if (pending) return pending

  const result = (async () => {
    const bytes = await renderInvoicePdf(invoice)
    await media.put(key, bytes, 'application/pdf')
    if (invoice.pdfPath !== key) {
      await client.invoice.update({ where: { id: invoice.id }, data: { pdfPath: key } }).catch(() => {})
    }
    return bytes
  })()
  generating.set(key, result)
  try { return await result }
  finally { if (generating.get(key) === result) generating.delete(key) }
}
