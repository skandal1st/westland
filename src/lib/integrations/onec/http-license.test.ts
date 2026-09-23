import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ open: vi.fn(), authenticate: vi.fn(), query: vi.fn(), acknowledge: vi.fn(), receive: vi.fn() }))
vi.mock('@/lib/store', () => ({ getActiveStore: async () => ({ id: 'store' }) }))
vi.mock('./ledger', () => ({
  openExchangeSession: mocks.open, authenticateSession: mocks.authenticate,
  initializeSession: mocks.receive, receiveChunk: mocks.receive, finishFile: mocks.receive, closeSession: mocks.receive,
}))
vi.mock('./sale', () => ({ querySales: mocks.query, acknowledgeSales: mocks.acknowledge }))
vi.mock('./sale-inbox', () => ({ receiveSaleFile: mocks.receive }))
import { handleOnecExchange } from './http'
import { COOKIE_NAME, mintSession } from './exchange'
import * as runtime from '@/lib/license/runtime'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('LICENSE_ENFORCE', '1')
  vi.stubEnv('NEXTAUTH_SECRET', 'test-secret')
  vi.stubEnv('ONEC_SOURCES_FILE', '')
  vi.stubEnv('ONEC_EXCHANGE_CONNECTION_ID', 'connection')
  vi.stubEnv('ONEC_EXCHANGE_USER', 'erp')
  vi.stubEnv('ONEC_EXCHANGE_PASSWORD', 'test-only')
  vi.spyOn(runtime, 'reloadLicenseState').mockReturnValue({ status: 'ABSENT', modules: [] })
  mocks.authenticate.mockResolvedValue({ connection: { enabled: true, sourceState: 'ACTIVE' } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
it('authentication failure stays 401; authenticated checkauth is blocked before session creation', async () => {
  const url = 'http://localhost/api/integrations/1c/exchange?type=catalog&mode=checkauth'
  expect((await handleOnecExchange(new Request(url))).status).toBe(401)
  const response = await handleOnecExchange(new Request(url, { headers: { authorization: 'Basic ' + Buffer.from('erp:test-only').toString('base64') } }))
  expect(response.status).toBe(403)
  expect(await response.text()).toBe('failure\nlicense_absent')
  expect(mocks.open).not.toHaveBeenCalled()
})
it.each(['sale&mode=query', 'catalog&mode=init', 'catalog&mode=import&filename=import.xml'])('an existing session cannot bypass the guard: %s', async operation => {
  const response = await handleOnecExchange(new Request('http://localhost/api/integrations/1c/exchange?type=' + operation, {
    headers: { cookie: COOKIE_NAME + '=' + mintSession('test-secret', 'session') },
  }))
  expect(response.status).toBe(403)
  expect(mocks.query).not.toHaveBeenCalled()
  expect(mocks.receive).not.toHaveBeenCalled()
})
it('a previously transmitted sale may still be acknowledged', async () => {
  const response = await handleOnecExchange(new Request('http://localhost/api/integrations/1c/exchange?type=sale&mode=success', {
    headers: { cookie: COOKIE_NAME + '=' + mintSession('test-secret', 'session') },
  }))
  expect(response.status).toBe(200)
  expect(mocks.acknowledge).toHaveBeenCalledTimes(1)
})
