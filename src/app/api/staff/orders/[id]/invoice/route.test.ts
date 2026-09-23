import { beforeEach, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), issue: vi.fn() }))
vi.mock('@/lib/authz', () => ({ requireApiUser: mocks.auth }))
vi.mock('@/lib/invoices/invoices', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/invoices/invoices')>(), issueInvoice: mocks.issue }))
import { POST } from './route'
import { InvoiceError } from '@/lib/invoices/invoices'
import { LicenseError } from '@/lib/license'
const actor = { id: 'staff', storeId: 'session-store' }
const body = { expectedVersion: 1, requestKey: '00000000-0000-4000-8000-000000000001' }
const params = { params: { id: 'order' } }
const request = (value: unknown = body) => new Request('http://localhost/api/staff/orders/order/invoice', { method: 'POST', body: JSON.stringify(value) })
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ user: actor }); mocks.issue.mockResolvedValue({ id: 'invoice', number: '1-R2', version: 2, status: 'ISSUED', repeated: false, total: { toFixed: () => '244.00' }, issuedAt: new Date() }) })
it.each([401, 403])('honors access denial %s before issuance', async status => {
  mocks.auth.mockResolvedValue({ response: NextResponse.json({ error: 'denied' }, { status }) })
  expect((await POST(request(), params)).status).toBe(status)
  expect(mocks.auth).toHaveBeenCalledWith(['STAFF', 'ADMIN'], 'invoices')
  expect(mocks.issue).not.toHaveBeenCalled()
})
it.each([{}, null, { ...body, total: '1.00' }, { ...body, storeId: 'foreign' }, { ...body, expectedVersion: -1 }, { ...body, requestKey: 'bad' }])('rejects missing or client-authoritative data: %j', async input => {
  expect((await POST(request(input), params)).status).toBe(400)
  expect(mocks.issue).not.toHaveBeenCalled()
})
it('uses the authenticated store, and distinguishes new issue from replay', async () => {
  expect((await POST(request(), params)).status).toBe(201)
  expect(mocks.issue).toHaveBeenCalledWith({ storeId: 'session-store', orderId: 'order', actor, ...body })
  mocks.issue.mockResolvedValue({ id: 'invoice', version: 2, status: 'VOID', repeated: true, total: { toFixed: () => '244.00' } })
  const replay = await POST(request(), params)
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ id: 'invoice', status: 'VOID', repeated: true })
})
it.each(['VERSION_CONFLICT', 'REQUEST_CONFLICT', 'NUMBER_CONFLICT', 'NO_BANK_REQUISITES'] as const)('returns a controlled 409 for %s', async code => {
  mocks.issue.mockRejectedValue(new InvoiceError(code))
  const response = await POST(request(), params)
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: code })
})
it('returns a controlled license denial', async () => {
  mocks.issue.mockRejectedValue(new LicenseError('ABSENT'))
  const response = await POST(request(), params)
  expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: 'license_absent' })
})
