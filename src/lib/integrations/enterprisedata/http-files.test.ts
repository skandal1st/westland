import { nativeFixture } from '../../../../tests/fixtures/enterprisedata-native'
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { fixture, now, peer as fixturePeer } from '../../../../tests/fixtures/enterprisedata'
import { FILE_METHODS, openFileTransport, type FileReply } from './http-files'
import { createEnterpriseDataProbe } from './http-probe'
import { digest, envelope, inspectMessage } from './message'
import { readXmlZip, writeXmlZip } from './zip'
const peer = { from: fixturePeer.from, to: fixturePeer.to, plan: fixturePeer.plan }
const pq = { NodeCode: peer.from, ExchangePlanName: peer.plan }
const dirs: string[] = [], servers: ReturnType<typeof createEnterpriseDataProbe>[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'axima-ed-files-')); dirs.push(dir); return dir }
const parsed = (r: FileReply) => JSON.parse(r.body.toString())
const empty = (number = 1, received = 0) => Buffer.from(envelope({ ...peer, messageNo: number, receivedNo: received }, [], now))
const q = (values: Record<string, string>) => new URLSearchParams(values)
function context(captureOrderSample = false, boundPeer = peer) {
  const dir = temp(), transport = openFileTransport(dir, () => boundPeer, captureOrderSample)
  const call = (op: string, values: Record<string, string>, body?: Buffer) => transport.handle(op, q(values), body)
  const upload = (xml: Buffer) => {
    const session = randomUUID(), zip = writeXmlZip(xml), count = Math.ceil(zip.length / 1024 / 1024)
    for (let i = 0; i < count; i++) call('PutFilePart', { SessionID: session, PartNumber: String(i + 1) }, zip.subarray(i * 1024 * 1024, (i + 1) * 1024 * 1024))
    return parsed(call('SaveFileFromParts', { SessionID: session, PartCount: String(count) })).FileID as string
  }
  return { dir, transport, call, upload, state: () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) }
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()) })))
  dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true }))
})
describe('EnterpriseData file transport', () => {
  it('advertises sample reception only on new messages and preserves pending payloads', () => {
    const c = context(), first = parsed(c.call('UploadData', pq))
    const read = (fileId: string) => {
      const session = parsed(c.call('PrepareGetFile', { FileID: fileId, BlockSize: '1024' }))
      return inspectMessage(readXmlZip(c.call('GetFilePart', { SessionID: session.SessionID, PartNumber: '1' }).body as Buffer))
    }
    expect(read(first.FileID).objectTypes).toEqual([{ name: 'Документ.ЗаказКлиента', sending: '1.20', receiving: '' }])
    const upgraded = openFileTransport(c.dir, () => peer, true)
    expect(parsed(upgraded.handle('UploadData', q(pq))).FileID).toBe(first.FileID)
    const ack = c.upload(empty(1, 1)); c.call('DownloadData', { ...pq, FileID: ack })
    const next = parsed(upgraded.handle('UploadData', q(pq)))
    expect(read(next.FileID).objectTypes).toEqual([{ name: 'Документ.ЗаказКлиента', sending: '1.20', receiving: '1.20' }])
    expect(read(next.FileID).objects).toEqual([])
  })

  it('persists empty receipts, replays pending bytes after restart and waits for protocol ACK', () => {
    const c = context(), id = c.upload(empty())
    const args = { ...pq, FileID: id }
    expect(parsed(c.call('DownloadData', args))).toEqual({ TimeConsumingOperation: false, OperationID: null })
    c.call('DownloadData', args); expect(c.state().inbound).toHaveLength(1)
    const out = parsed(c.call('UploadData', pq)), session = parsed(c.call('PrepareGetFile', { FileID: out.FileID, BlockSize: '1024' }))
    const bytes = c.call('GetFilePart', { SessionID: session.SessionID, PartNumber: '1' }).body as Buffer
    expect(inspectMessage(readXmlZip(bytes)).confirmation).toEqual({ from: peer.to, to: peer.from, plan: peer.plan, messageNo: 1, receivedNo: 1 })
    c.call('ReleaseFile', { SessionID: session.SessionID }); c.call('ReleaseFile', { SessionID: session.SessionID })
    expect(() => c.call('GetFilePart', { SessionID: session.SessionID, PartNumber: '1' })).toThrow('ed_file_read_session_released')
    const restart = openFileTransport(c.dir, () => peer)
    expect(parsed(restart.handle('UploadData', q(pq)))).toEqual(out)
    expect(c.state().acknowledged).toBe(0)
    const ack = c.upload(empty(2, 1)); c.call('DownloadData', { ...pq, FileID: ack })
    expect(parsed(c.call('UploadData', pq)).FileID).not.toBe(out.FileID)
    expect(c.state().acknowledged).toBe(1); expect(c.state().outbound).toHaveLength(2)
  })
  it('does not acknowledge nonempty XML, even on retry, and prevents replacing its number', () => {
    const c = context(true), id = c.upload(fixture().evidence)
    for (let i = 0; i < 2; i++) expect(() => c.call('DownloadData', { ...pq, FileID: id })).toThrow('ed_business_payload_saved_not_applied')
    expect(c.state().applied).toBe(0); expect(c.state().inbound).toHaveLength(1)
    expect(c.state().inbound[0]).toMatchObject({ objects: 1, applied: false })
    const other = c.upload(empty())
    expect(() => c.call('DownloadData', { ...pq, FileID: other })).toThrow('ed_file_message_conflict')
  })
  it('recovers a blocked sample followed by an empty message without skipping or changing outgoing bytes', () => {
    const c = context(true), xml = fixture().evidence, id = c.upload(xml)
    const out = parsed(c.call('UploadData', pq))
    const outgoingBytes = readFileSync(join(c.dir, 'out-' + out.FileID + '.zip'))
    expect(() => c.call('DownloadData', { ...pq, FileID: id })).toThrow('ed_business_payload_saved_not_applied')
    const next = c.upload(empty(2, 1))
    expect(() => c.call('DownloadData', { ...pq, FileID: next })).toThrow('ed_file_message_counter_invalid')
    const proof = { sha256: digest(xml), schemaSha256: '73f126576f9947626b8b9a6da7306ff04223408bc235627fbc61a20899f6c8fb' as const, ordersValidated: 1, purpose: 'schema-sample-only' as const }
    const review = c.transport.acceptReviewedSample(proof)
    expect(review.businessImported).toBe(false)
    expect(c.state()).toMatchObject({ applied: 1, acknowledged: 0, sampleReviews: [review] })
    expect(parsed(c.call('UploadData', pq))).toEqual(out)
    expect(readFileSync(join(c.dir, 'out-' + out.FileID + '.zip'))).toEqual(outgoingBytes)
    c.call('DownloadData', { ...pq, FileID: next })
    const restart = openFileTransport(c.dir, () => peer, true)
    expect(restart.acceptReviewedSample(proof)).toEqual(review)
    expect(parsed(restart.handle('DownloadData', q({ ...pq, FileID: id })))).toMatchObject({ TimeConsumingOperation: false })
    expect(c.state()).toMatchObject({ applied: 2, acknowledged: 1, sampleReviews: [review] })
    const output = parsed(c.call('UploadData', pq))
    const session = parsed(c.call('PrepareGetFile', { FileID: output.FileID, BlockSize: '1024' }))
    expect(inspectMessage(readXmlZip(c.call('GetFilePart', { SessionID: session.SessionID, PartNumber: '1' }).body as Buffer)).confirmation.receivedNo).toBe(2)
    const newSample = c.upload(Buffer.from(xml.toString().replace('<msg:MessageNo>1</msg:MessageNo>', '<msg:MessageNo>3</msg:MessageNo>').replace('<msg:ReceivedNo>0</msg:ReceivedNo>', '<msg:ReceivedNo>1</msg:ReceivedNo>')))
    expect(() => c.call('DownloadData', { ...pq, FileID: newSample })).toThrow('ed_business_payload_saved_not_applied')
    expect(c.state().applied).toBe(2)
  })
  it('fails closed on disabled capture, unvalidated count, unknown digest, schema or changed sample bytes', () => {
    const c = context(true), xml = fixture().evidence, id = c.upload(xml)
    expect(() => c.call('DownloadData', { ...pq, FileID: id })).toThrow('ed_business_payload_saved_not_applied')
    const proof = { sha256: digest(xml), schemaSha256: '73f126576f9947626b8b9a6da7306ff04223408bc235627fbc61a20899f6c8fb' as const, ordersValidated: 1, purpose: 'schema-sample-only' as const }
    const before = c.state()
    expect(() => openFileTransport(c.dir, () => peer).acceptReviewedSample(proof)).toThrow('ed_sample_capture_disabled')
    expect(() => c.transport.acceptReviewedSample({ ...proof, sha256: '0'.repeat(64) })).toThrow('ed_sample_pending_required')
    expect(() => c.transport.acceptReviewedSample({ ...proof, ordersValidated: 2 })).toThrow('ed_sample_objects_mismatch')
    expect(() => c.transport.acceptReviewedSample({ ...proof, schemaSha256: 'wrong' as typeof proof.schemaSha256 })).toThrow('ed_sample_validation_invalid')
    writeFileSync(join(c.dir, 'message-' + proof.sha256 + '.xml'), empty())
    expect(() => c.transport.acceptReviewedSample(proof)).toThrow('ed_sample_bytes_changed')
    expect(c.state()).toEqual(before)
  })
  it('publishes one new test order in the HTTP journal and replays it unchanged until peer ACK', () => {
    const boundPeer = { ...peer, to: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
    const c = context(true, boundPeer), { input, evidence, oldId } = nativeFixture()
    let validated = 0
    const validate = (xml: Buffer) => { validated++; expect(inspectMessage(xml).objects).toHaveLength(1) }
    const order = c.transport.queueNativeTestOrder(input, evidence, validate)
    expect(order.messageNo).toBe(1); expect(order.documentId).not.toBe(oldId)
    const out = parsed(c.call('UploadData', pq))
    const restart = openFileTransport(c.dir, () => boundPeer, true)
    expect(restart.queueNativeTestOrder(input, evidence, validate)).toMatchObject({ ...order, reused: true })
    expect(validated).toBe(1)
    expect(parsed(restart.handle('UploadData', q(pq)))).toEqual(out)
    const read = parsed(c.call('PrepareGetFile', { FileID: out.FileID, BlockSize: '1024' }))
    const message = inspectMessage(readXmlZip(c.call('GetFilePart', { SessionID: read.SessionID, PartNumber: '1' }).body as Buffer))
    expect(message.confirmation).toMatchObject({ from: boundPeer.to, to: boundPeer.from, messageNo: 1, receivedNo: 0 })
    expect(message.objects).toHaveLength(1)
    const ack = c.upload(Buffer.from(envelope({ ...boundPeer, messageNo: 1, receivedNo: 1 }, [], now)))
    c.call('DownloadData', { ...pq, FileID: ack })
    expect(c.state().acknowledged).toBe(1)
    const next = parsed(c.call('UploadData', pq)); expect(next.FileID).not.toBe(out.FileID)
    expect(() => restart.queueNativeTestOrder({ ...input, requestKey: 'another' }, evidence, validate)).toThrow('ed_single_test_order_limit')
    expect(() => restart.queueNativeTestOrder({ ...input, deliveryMethod: 'Самовывоз' }, evidence, validate)).toThrow('ed_test_order_conflict')
  })
  it('does not publish a test order when schema validation fails or a prior message is pending', () => {
    const boundPeer = { ...peer, to: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
    const c = context(true, boundPeer), { input, evidence } = nativeFixture()
    expect(() => c.transport.queueNativeTestOrder(input, evidence, () => { throw Error('XSD failed') })).toThrow('XSD failed')
    const first = parsed(c.call('UploadData', pq))
    expect(c.state().testOrders).toEqual([])
    expect(() => c.transport.queueNativeTestOrder(input, evidence, () => {})).toThrow('ed_test_order_exchange_pending')
    expect(parsed(c.call('UploadData', pq))).toEqual(first)
    expect(c.state().outbound).toHaveLength(1)
  })
  it('rejects wrong node, counter gaps, impossible ACK and wrong XML sender', () => {
    const c = context()
    expect(() => c.call('UploadData', { ...pq, NodeCode: 'other' })).toThrow('ed_file_peer_mismatch')
    for (const xml of [empty(2), empty(1, 1)]) {
      const id = c.upload(xml)
      expect(() => c.call('DownloadData', { ...pq, FileID: id })).toThrow('ed_file_message_counter_invalid')
    }
    const id = c.upload(Buffer.from(envelope({ ...peer, from: 'OTHER', messageNo: 1, receivedNo: 0 }, [], now)))
    expect(() => c.call('DownloadData', { ...pq, FileID: id })).toThrow('ed_file_message_peer_mismatch')
  })
  it('enforces immutable parts, complete assembly, chunk limit, query validation and bounded sessions', () => {
    const c = context(), SessionID = randomUUID(), zip = writeXmlZip(empty())
    c.call('PutFilePart', { SessionID, PartNumber: '1' }, zip); c.call('PutFilePart', { SessionID, PartNumber: '1' }, zip)
    expect(() => c.call('PutFilePart', { SessionID, PartNumber: '1' }, Buffer.from('different'))).toThrow('ed_file_part_conflict')
    expect(() => c.call('SaveFileFromParts', { SessionID, PartCount: '2' })).toThrow('ed_file_parts_incomplete')
    c.call('SaveFileFromParts', { SessionID, PartCount: '1' })
    expect(() => c.call('PutFilePart', { SessionID, PartNumber: '2' }, zip)).toThrow('ed_file_part_conflict')
    expect(() => c.call('PutFilePart', { SessionID: randomUUID(), PartNumber: '1' }, Buffer.alloc(1024 * 1024 + 1))).toThrow('ed_file_part_size')
    expect(() => c.call('PutFilePart', { SessionID: '../escape', PartNumber: '1' }, zip)).toThrow('ed_file_id_invalid')
    expect(() => c.call('UploadData', { ...pq, Password: 'secret' })).toThrow('ed_file_query_invalid')
    expect(() => c.call('constructor', {})).toThrow('ed_file_operation_unsupported')
    for (let i = 1; i < 32; i++) c.call('PutFilePart', { SessionID: randomUUID(), PartNumber: '1' }, zip)
    expect(() => c.call('PutFilePart', { SessionID: randomUUID(), PartNumber: '1' }, zip)).toThrow('ed_file_session_limit')
  })
  it('rejects disk corruption and unknown read parts', () => {
    const c = context(), out = parsed(c.call('UploadData', pq))
    const r = parsed(c.call('PrepareGetFile', { FileID: out.FileID, BlockSize: '1024' }))
    expect(() => c.call('GetFilePart', { SessionID: r.SessionID, PartNumber: '2' })).toThrow('ed_file_part_out_of_range')
    writeFileSync(join(c.dir, 'out-' + out.FileID + '.zip'), 'corrupted')
    expect(() => c.call('GetFilePart', { SessionID: r.SessionID, PartNumber: '1' })).toThrow('ed_file_archive_corrupt')
  })
  it('runs the HTTP upload/download/release protocol with binary response and controlled audit', async () => {
    const dir = temp(), events: unknown[] = [], password = 'z'.repeat(40)
    const server = createEnterpriseDataProbe({ username: 'test', password, basePath: '/ed', files: openFileTransport(dir, () => peer), audit: e => { events.push(e) } }); servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/ed/hs/exchange_dsl_1_0_0_1/v1/'
    const request = (op: string, values: Record<string, string>, body?: Buffer) => fetch(base + op + '?' + q(values), { method: FILE_METHODS[op], headers: { Authorization: 'Basic ' + Buffer.from('test:' + password).toString('base64') }, body: body as unknown as BodyInit })
    const SessionID = randomUUID(), zip = writeXmlZip(empty())
    expect((await request('PutFilePart', { SessionID, PartNumber: '1' }, zip)).status).toBe(200)
    const saved = await request('SaveFileFromParts', { SessionID, PartCount: '1' }); expect(saved.status).toBe(200)
    const input = await saved.json()
    expect((await request('DownloadData', { ...pq, FileID: input.FileID })).status).toBe(200)
    const out = await (await request('UploadData', pq)).json()
    const r = await (await request('PrepareGetFile', { FileID: out.FileID, BlockSize: '1024' })).json()
    const part = await request('GetFilePart', { SessionID: r.SessionID, PartNumber: '1' }); expect(part.status).toBe(200)
    expect(part.headers.get('content-type')).toBe('application/octet-stream')
    expect(inspectMessage(readXmlZip(Buffer.from(await part.arrayBuffer()))).objects).toEqual([])
    expect((await request('ReleaseFile', { SessionID: r.SessionID })).status).toBe(200)
    expect((await request('PutFilePart', { SessionID, PartNumber: '1' }, Buffer.alloc(1024 * 1024 + 1))).status).toBe(413)
    expect((await request('UploadData', { ...pq, NodeCode: 'private-wrong-node' })).status).toBe(409)
    expect(JSON.stringify(events)).not.toMatch(/private-wrong-node|OFFLINE|Basic|Message.xml/)
    expect(events.at(-1)).toMatchObject({ operation: 'UploadData', status: 409, errorCode: 'ed_file_peer_mismatch' })
  })
})
