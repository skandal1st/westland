import { beforeEach, expect, it, vi } from 'vitest'
import type { InvoiceWithLines } from './invoices'
import { getInvoicePdf } from './pdf-service'
const mocks = vi.hoisted(() => ({ render: vi.fn(), get: vi.fn(), put: vi.fn(), update: vi.fn() }))
vi.mock('@/lib/invoices/pdf', () => ({ renderInvoicePdf: mocks.render }))
vi.mock('@/lib/media', () => ({ getMediaStore: () => ({ get: mocks.get, put: mocks.put }) }))
vi.mock('@/lib/db', () => ({ prisma: { invoice: { update: mocks.update } } }))
const invoice = { id: 'same-invoice', version: 1, pdfPath: null } as InvoiceWithLines
beforeEach(() => {
  vi.resetAllMocks()
  mocks.get.mockResolvedValue(null)
  mocks.put.mockResolvedValue({ key: 'invoices/same-invoice-v1.pdf' })
  mocks.update.mockResolvedValue({})
})
it('coalesces cold-cache downloads into one complete render and write', async () => {
  let done!: (bytes: Buffer) => void
  mocks.render.mockReturnValue(new Promise<Buffer>(resolve => { done = resolve }))
  const requests = Array.from({ length: 8 }, () => getInvoicePdf(invoice))
  await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1))
  const bytes = Buffer.from('%PDF-complete')
  done(bytes)
  expect(await Promise.all(requests)).toEqual(Array(8).fill(bytes))
  expect(mocks.put).toHaveBeenCalledTimes(1)
  expect(mocks.update).toHaveBeenCalledTimes(1)
})
it('clears a failed render so a later request can retry', async () => {
  mocks.render.mockRejectedValueOnce(new Error('render_failed')).mockResolvedValueOnce(Buffer.from('recovered'))
  await expect(getInvoicePdf(invoice)).rejects.toThrow('render_failed')
  expect(await getInvoicePdf(invoice)).toEqual(Buffer.from('recovered'))
  expect(mocks.render).toHaveBeenCalledTimes(2)
})
it('retries a failed cache write without recording success', async () => {
  mocks.render.mockResolvedValue(Buffer.from('pdf'))
  mocks.put.mockRejectedValueOnce(new Error('disk_full'))
  await expect(getInvoicePdf(invoice)).rejects.toThrow('disk_full')
  expect(mocks.update).not.toHaveBeenCalled()
  expect(await getInvoicePdf(invoice)).toEqual(Buffer.from('pdf'))
  expect(mocks.update).toHaveBeenCalledTimes(1)
})
