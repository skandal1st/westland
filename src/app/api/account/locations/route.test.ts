import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), create: vi.fn() }))
vi.mock('@/lib/authz', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/lib/account/locations', async original => ({ ...await original<typeof import('@/lib/account/locations')>(), createBuyerLocation: mocks.create }))
import { POST } from './route'
const request = (data: unknown) => new Request('http://localhost/api/account/locations', { method: 'POST', body: JSON.stringify(data) })
beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: 'buyer' }); mocks.create.mockResolvedValue({ id: 'point' }) })
it('rejects a destination exceeding the CommerceML address limit before creating a point', async () => {
  const response = await POST(request({ name: 'Shop', city: 'X', address: 'x'.repeat(253) }))
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: 'address_too_long' })
  expect(mocks.create).not.toHaveBeenCalled()
})
it('accepts the full 255-character destination without truncation', async () => {
  expect((await POST(request({ name: ' Shop ', city: ' X ', address: 'x'.repeat(252) }))).status).toBe(201)
  expect(mocks.create).toHaveBeenCalledWith({ id: 'buyer' }, { name: 'Shop', city: 'X', address: 'x'.repeat(252) })
})
it.each(['name', 'city', 'address'])('rejects a whitespace-only %s', async field => {
  expect((await POST(request({ name: 'Shop', city: 'City', address: 'Street', [field]: '  ' }))).status).toBe(400)
  expect(mocks.create).not.toHaveBeenCalled()
})
