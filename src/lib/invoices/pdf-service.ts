import type { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '@/lib/db'
import { getMediaStore } from '@/lib/media'
import { renderInvoicePdf } from '@/lib/invoices/pdf'
import type { InvoiceWithLines } from '@/lib/invoices/invoices'

/** Media key for an invoice's rendered PDF — version-scoped so a reissue can't serve a stale file. */
export function invoicePdfKey(invoice: { id: string; version: number }): string {
  return `invoices/${invoice.id}-v${invoice.version}.pdf`
}

/**
 * Return the invoice PDF, using the media store as a cache. On a miss the PDF is
 * regenerated from the immutable snapshot (byte-identical), stored, and its key
 * recorded on `Invoice.pdfPath`. Losing the cached file never loses the invoice.
 */
export async function getInvoicePdf(invoice: InvoiceWithLines, client: PrismaClient = defaultPrisma): Promise<Buffer> {
  const media = getMediaStore()
  const key = invoicePdfKey(invoice)

  const cached = await media.get(key)
  if (cached) return cached

  const bytes = await renderInvoicePdf(invoice)
  await media.put(key, bytes, 'application/pdf')
  if (invoice.pdfPath !== key) {
    await client.invoice.update({ where: { id: invoice.id }, data: { pdfPath: key } }).catch(() => {})
  }
  return bytes
}
