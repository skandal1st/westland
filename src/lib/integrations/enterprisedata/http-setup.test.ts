import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { ED_PLAN, openHttpSetup } from './http-setup'
import { createEnterpriseDataProbe } from './http-probe'
import { FORMAT_BASE } from './message'
const paths: string[] = [], servers: ReturnType<typeof createEnterpriseDataProbe>[] = []
const temporary = () => { const p = mkdtempSync(join(tmpdir(), 'axima-ed-setup-')); paths.push(p); return p }
const query = (node = 'PEER-TEST') => new URLSearchParams({ ExchangePlanName: ED_PLAN, NodeCode: node, IsXDTOExchangePlan: 'true', SettingID: 'test' })
const input = (own: string) => ({
  MainExchangeParameters: { FormatVersion: '2.0', NodeCode: 'PEER-TEST', CorrespondentNodeCode: own,
    ExchangePlanName: 'DataSynchronizationViaUniversalFormat', CorrespondentExchangePlanName: 'DataSynchronizationViaUniversalFormat',
    SentNo: 0, ReceivedNo: 0, ExchangeFormatVersions: ['1.20', '1.21'], TransportID: 'HTTP',
    SourceInfobasePrefix: 'UT', DestinationInfobasePrefix: 'AX', ThisInfobaseDescription: 'Тест УТ', SecondInfobaseDescription: 'AXIMA',
  },
  XDTOExchangeParameters: { ExchangeFormat: FORMAT_BASE },
  SupportedObjectsInFormat: [{ Object: 'Документ.ЗаказКлиента', Send: ['1.20'], Receive: [] as string[] }],
  TransportSettings: { Password: 'DO_NOT_PERSIST', Username: 'DO_NOT_PERSIST' }, ExtraField: 'DO_NOT_PERSIST',
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()) })))
  paths.splice(0).forEach(p => rmSync(p, { recursive: true, force: true }))
})
describe('EnterpriseData HTTP onboarding', () => {
  it('announces sample sending in caller-facing JSON without resetting node identity', () => {
    const dir = temporary(), setup = openHttpSetup(dir), before = setup.parameters(query())
    setup.create(input(before.ThisNodeCode))
    const updated = openHttpSetup(dir, true).parameters(query())
    expect(updated.NodeExists).toBe(true); expect(updated.ThisNodeCode).toBe(before.ThisNodeCode)
    expect(updated.SupportedObjectsInFormat).toEqual([{ Object: 'Документ.ЗаказКлиента', Send: ['1.20'], Receive: ['1.20'] }])
  })

  it('preserves own identity across restart and announces receiver-facing directions', () => {
    const dir = temporary(), setup = openHttpSetup(dir), p = setup.parameters(query())
    expect(p.ThisNodeCode).toBe(openHttpSetup(dir).parameters(query()).ThisNodeCode)
    expect(p.SupportedObjectsInFormat).toEqual([{ Object: 'Документ.ЗаказКлиента', Send: [], Receive: ['1.20'] }])
    expect(p.NodeExists).toBe(false); expect(p.DataSynchronizationSetupCompleted).toBe(false)
    expect(p.DataMappingSupported).toBe(false)
  })
  it('stores only validated settings, supports repeat and does not initialize business counters', () => {
    const dir = temporary(), setup = openHttpSetup(dir), body = input(setup.parameters(query()).ThisNodeCode)
    expect(setup.create(body)).toEqual({ reused: false }); expect(setup.create(body)).toEqual({ reused: true })
    const p = openHttpSetup(dir).parameters(query()); expect(p.NodeExists).toBe(true); expect(p.DataSynchronizationSetupCompleted).toBe(false)
    expect(readFileSync(join(dir, 'peer-setup.json'), 'utf8')).not.toContain('DO_NOT_PERSIST')
    expect(readdirSync(dir).sort()).toEqual(['identity.json', 'peer-setup.json'])
    expect(() => setup.parameters(query('OTHER'))).toThrow('ed_setup_peer_mismatch')
    expect(() => setup.create({ ...body, MainExchangeParameters: { ...body.MainExchangeParameters, NodeCode: 'OTHER' } })).toThrow('ed_setup_already_bound')
  })
  it('rejects existing message counters rather than resetting them', () => {
    const setup = openHttpSetup(temporary()), body = input(setup.parameters(query()).ThisNodeCode)
    expect(() => setup.create({ ...body, MainExchangeParameters: { ...body.MainExchangeParameters, SentNo: 1 } })).toThrow('ed_setup_contract_invalid')
    expect(setup.parameters(query()).NodeExists).toBe(false)
  })
  it('rejects wrong recipient, unavailable format and wrong order direction', () => {
    const setup = openHttpSetup(temporary()), body = input(setup.parameters(query()).ThisNodeCode)
    expect(() => setup.create(input('OTHER'))).toThrow('ed_setup_destination_mismatch')
    expect(() => setup.create({ ...body, MainExchangeParameters: { ...body.MainExchangeParameters, ExchangeFormatVersions: ['1.25'] } })).toThrow('ed_setup_version_unsupported')
    expect(() => setup.create({ ...body, SupportedObjectsInFormat: [{ Object: 'Документ.ЗаказКлиента', Send: [], Receive: ['1.20'] }] })).toThrow('ed_setup_order_receiving_unsupported')
    expect(setup.parameters(query()).NodeExists).toBe(false)
  })
  it('rejects duplicate capabilities and unrecognized query keys', () => {
    const setup = openHttpSetup(temporary()), body = input(setup.parameters(query()).ThisNodeCode)
    expect(() => setup.create({ ...body, SupportedObjectsInFormat: [body.SupportedObjectsInFormat[0], body.SupportedObjectsInFormat[0]] })).toThrow('ed_setup_duplicate_capabilities')
    const q = query(); q.append('NodeCode', 'OTHER')
    expect(() => setup.parameters(q)).toThrow('ed_setup_query_invalid')
  })
  it('performs authenticated HTTP parameters/create flow while refusing business messages', async () => {
    const dir = temporary(), setup = openHttpSetup(dir), username = 'ed-setup-test', password = 'y'.repeat(40), basePath = '/ed'
    const server = createEnterpriseDataProbe({ username, password, basePath, setup }); servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + basePath + '/hs/exchange_dsl_1_0_0_1/v1/'
    const headers = { Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') }
    expect((await fetch(base + 'GetIBParameters?' + query())).status).toBe(401)
    const response = await fetch(base + 'GetIBParameters?' + query(), { headers }); expect(response.status).toBe(200)
    const parameters = await response.json(), body = input(parameters.ThisNodeCode)
    const created = await fetch(base + 'CreateExchangeNode', { headers, method: 'POST', body: JSON.stringify(body) })
    expect(created.status).toBe(200); expect(await created.text()).toBe('')
    expect((await fetch(base + 'CreateExchangeNode', { headers, method: 'POST', body: '{invalid' })).status).toBe(400)
    expect((await fetch(base + 'CreateExchangeNode', { headers, method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413)
    expect((await fetch(base + 'UploadData', { headers, method: 'POST' })).status).toBe(501)
    expect((await fetch(base + 'DownloadData', { headers, method: 'POST', body: '<Message/>' })).status).toBe(413)
  })
})
