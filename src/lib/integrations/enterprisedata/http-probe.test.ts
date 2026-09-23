import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import { createEnterpriseDataProbe, type ProbeOptions } from './http-probe'
const options = { username: 'ed-unit-test', password: 'x'.repeat(40), basePath: '/ed-test' }
const auth = 'Basic ' + Buffer.from(options.username + ':' + options.password).toString('base64')
const running: ReturnType<typeof createEnterpriseDataProbe>[] = []
afterEach(async () => { await Promise.all(running.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()) }))) })
async function start(extra: Partial<ProbeOptions> = {}) {
  const server = createEnterpriseDataProbe({ ...options, ...extra }); running.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port + options.basePath + '/hs/exchange_dsl_1_0_0_1'
}
describe('EnterpriseData HTTP connectivity probe', () => {
  it('implements the observed SSL version request only after authentication', async () => {
    const base = await start()
    const noAuth = await fetch(base + '/version'); expect(noAuth.status).toBe(401)
    expect(noAuth.headers.get('www-authenticate')).toContain('Basic')
    const result = await fetch(base + '/version', { headers: { Authorization: auth } })
    expect(result.status).toBe(200); expect(await result.text()).toBe('1')
    expect(result.headers.get('cache-control')).toBe('no-store')
  })
  it.each(['Basic invalid', 'Bearer ' + 'x'.repeat(40), 'Basic ' + Buffer.from(options.username + ':wrong').toString('base64')])('rejects wrong credentials %s', async value => {
    expect((await fetch(await start() + '/version', { headers: { Authorization: value } })).status).toBe(401)
  })
  it.each(['GetIBParameters', 'CreateExchangeNode', 'PutFilePart', 'DownloadData', 'UploadData', 'RemoveExchangeNode'])('never fakes success for %s', async operation => {
    const response = await fetch(await start() + '/v1/' + operation, { method: operation === 'GetIBParameters' ? 'GET' : 'POST', headers: { Authorization: auth } })
    expect(response.status).toBe(501); expect((await response.json()).message).toContain('данные не приняты')
  })
  it('rejects bodies, unexpected methods and queries on the version route', async () => {
    const base = await start(), headers = { Authorization: auth }
    expect((await fetch(base + '/version', { headers, method: 'POST', body: 'sensitive data' })).status).toBe(413)
    expect((await fetch(base + '/version', { headers, method: 'POST' })).status).toBe(405)
    expect((await fetch(base + '/version?token=secret', { headers })).status).toBe(400)
  })
  it('logs only controlled labels and status, never credentials, payload or query', async () => {
    const events: unknown[] = [], base = await start({ audit: e => { events.push(e) } })
    await fetch(base + '/v1/GetIBParameters?password=secret&NodeCode=private', { headers: { Authorization: auth } })
    expect(events).toEqual([{ at: expect.any(String), operation: 'GetIBParameters', status: 501 }])
    expect(JSON.stringify(events)).not.toMatch(/secret|private|Basic/)
  })
  it('fails closed when evidence cannot be written', async () => {
    const base = await start({ audit: () => { throw Error('full') } })
    expect((await fetch(base + '/version', { headers: { Authorization: auth } })).status).toBe(503)
  })
  it('rejects weak configuration before binding', () => {
    expect(() => createEnterpriseDataProbe({ ...options, password: 'short' })).toThrow('ed_probe_config_invalid')
    expect(() => createEnterpriseDataProbe({ ...options, basePath: '/ed/../prod' })).toThrow('ed_probe_config_invalid')
  })
})
