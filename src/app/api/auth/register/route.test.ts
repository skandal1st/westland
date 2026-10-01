import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@/lib/registration', () => ({
  createRegistrationRequest: mocks.create,
  RegistrationError: class RegistrationError extends Error {
    constructor(public code: string) { super(code) }
  },
}))
vi.mock('@/lib/rate-limit', () => ({ clientIp: () => '127.0.0.1', rateLimit: () => ({ ok: true }) }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))

import { POST } from './route'

const request = (body: unknown) => new Request('http://localhost/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const requiredFields = {
  email: 'buyer@example.test',
  password: 'password12',
  contactName: 'Покупатель',
  legalName: 'ООО Покупатель',
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockResolvedValue({ status: 'PENDING' })
})

describe('registration API', () => {
  it('accepts a registration without INN and KPP', async () => {
    const response = await POST(request(requiredFields))

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ status: 'pending' })
    expect(mocks.create).toHaveBeenCalledWith(requiredFields)
  })

  it('accepts explicitly empty optional requisites from the browser form', async () => {
    const response = await POST(request({ ...requiredFields, inn: '', kpp: '' }))

    expect(response.status).toBe(201)
    expect(mocks.create).toHaveBeenCalledWith({ ...requiredFields, inn: '', kpp: '' })
  })
})
