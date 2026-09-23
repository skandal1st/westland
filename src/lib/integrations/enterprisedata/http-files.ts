import { documentUuid, OrderInputSchema, renderOrder, requestDigest } from './order'
import { validateNativeReferences, type NativeEvidence } from './native-evidence'
import { pilotCapabilities } from './capabilities'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { digest, ED_NS, envelope, parseXml, scalar, child, EnterpriseDataError, inspectMessage } from './message'
import { SetupError } from './http-setup'
import { readXmlZip, writeXmlZip, MAX_ZIP_BYTES } from './zip'
export type TransportPeer = { from: string; to: string; plan: string }
export const FILE_METHODS: Record<string, string> = { PutFilePart: 'POST', SaveFileFromParts: 'POST', DownloadData: 'POST', PutMessageForDataMatching: 'POST', UploadData: 'POST', PrepareGetFile: 'POST', GetFilePart: 'GET', ReleaseFile: 'DELETE' }
const CHUNK = 1024 * 1024, QUOTA = 128 * CHUNK
const uuid = z.string().uuid().transform(v => v.toLowerCase())
const hash = z.string().regex(/^[a-f0-9]{64}$/), n = z.number().int().nonnegative()
const SampleValidation = z.object({
  sha256: hash, schemaSha256: z.literal('73f126576f9947626b8b9a6da7306ff04223408bc235627fbc61a20899f6c8fb'),
  ordersValidated: z.number().int().positive().max(1000), purpose: z.literal('schema-sample-only'),
}).strict()
const SampleReview = SampleValidation.extend({ reviewedAt: z.string().datetime(), businessImported: z.literal(false) })
const State = z.object({
  version: z.literal(1), peer: z.object({ from: z.string(), to: z.string(), plan: z.string() }), applied: n, acknowledged: n,
  uploads: z.record(z.object({ parts: z.record(hash), sealedCount: n.optional(), zipHash: hash.optional() })),
  inbound: z.array(z.object({ number: n, received: n, sha256: hash, objects: n, applied: z.boolean() })),
  outbound: z.array(z.object({ number: n, fileId: uuid, zipHash: hash, xmlHash: hash })),
  sampleReviews: z.array(SampleReview).default([]),
  siteBinding: z.object({ storeId: z.string(), connectionId: z.string() }).optional(),
  siteOrders: z.array(z.object({ deliveryId: z.string().uuid(), documentHash: hash, messageNo: n })).default([]),
  testOrders: z.array(z.object({ key: z.string(), requestHash: hash, evidenceHash: hash, provenance: z.literal('user-supplied-native'), originalDocumentId: uuid, orderId: z.string(), number: z.string(), documentId: uuid, messageNo: n, xmlHash: hash, queuedAt: z.string().datetime() })).max(1).default([]),
  reads: z.record(z.object({ fileId: uuid, block: n, released: z.boolean() })),
})
const refuse = (status: number, code: string): never => { throw new SetupError(status, code) }
function id(value: string | null) { const p = uuid.safeParse(value); return p.success ? p.data : refuse(400, 'ed_file_id_invalid') }
function integer(value: string | null, max: number) {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) return refuse(400, 'ed_file_number_invalid')
  return Number(value)
}
export type FileReply = { body: string | Buffer; type: 'json' | 'text' | 'binary' }
const json = (value: unknown): FileReply => ({ body: JSON.stringify(value), type: 'json' })
/** Business XML is retained without ACK until explicitly reviewed locally as a schema sample. No business importer. */
export function openFileTransport(dir: string, getPeer: () => TransportPeer, captureOrderSample = false, limits = { messages: 32, sessions: 32, reads: 64, quota: QUOTA }, directoryEnabled = false) {
  mkdirSync(dir, { recursive: true })
  function atomic(path: string, data: Buffer | string) {
    const temp = path + '.' + randomUUID() + '.tmp', fd = openSync(temp, 'wx', 0o600)
    try { writeFileSync(fd, data); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, path)
  }
  function persistBlob(name: string, data: Buffer) {
    const path = join(dir, name)
    if (existsSync(path)) { if (digest(readFileSync(path)) !== digest(data)) refuse(409, 'ed_file_bytes_conflict'); return }
    const used = readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
    if (used + data.length > limits.quota) refuse(507, 'ed_file_storage_quota')
    atomic(path, data)
  }
  function withState<T>(action: (state: z.infer<typeof State>, save: () => void) => T): T {
    const peer = getPeer()
    const lock = join(dir, '.lock'); let fd: number
    try { fd = openSync(lock, 'wx', 0o600) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return refuse(409, 'ed_file_busy'); throw e }
    try {
      const path = join(dir, 'state.json')
      const state = existsSync(path) ? State.parse(JSON.parse(readFileSync(path, 'utf8')))
        : State.parse({ version: 1, peer, applied: 0, acknowledged: 0, uploads: {}, inbound: [], outbound: [], reads: {} })
      if (JSON.stringify(state.peer) !== JSON.stringify(peer)) refuse(409, 'ed_file_bound_peer_changed')
      if (state.acknowledged > state.outbound.length || state.outbound.some((o, i) => o.number !== i + 1)) refuse(503, 'ed_file_state_invalid')
      const save = () => atomic(path, JSON.stringify(state, null, 2))
      return action(state, save)
    } catch (error) { if (error instanceof EnterpriseDataError) throw new SetupError(422, error.code); throw error }
    finally { closeSync(fd); unlinkSync(lock) }
  }
  function validateRequest(operation: string, q: URLSearchParams, body: Buffer = Buffer.alloc(0)) {
      const fields: Record<string, string[]> = {
        PutFilePart: ['SessionID', 'PartNumber'], SaveFileFromParts: ['SessionID', 'PartCount'],
        DownloadData: ['ExchangePlanName', 'NodeCode', 'FileID', 'TimeConsumingOperationAllowed'],
        PutMessageForDataMatching: ['ExchangePlanName', 'NodeCode', 'FileID'],
        UploadData: ['ExchangePlanName', 'NodeCode', 'TimeConsumingOperationAllowed'],
        PrepareGetFile: ['FileID', 'BlockSize'], GetFilePart: ['SessionID', 'PartNumber'], ReleaseFile: ['SessionID'],
      }
      if (!Object.prototype.hasOwnProperty.call(fields, operation)) return refuse(501, 'ed_file_operation_unsupported')
      for (const key of Array.from(q.keys())) if (!fields[operation].includes(key) || q.getAll(key).length !== 1) refuse(400, 'ed_file_query_invalid')
      const peer = getPeer() // A persisted, authenticated node is required before any file operation.
      if (fields[operation].includes('NodeCode') && (q.get('NodeCode') !== peer.from || ![peer.plan, 'СинхронизацияДанныхЧерезУниверсальныйФормат', 'DataSynchronizationViaUniversalFormat'].includes(q.get('ExchangePlanName') ?? ''))) refuse(409, 'ed_file_peer_mismatch')
      if (operation !== 'PutFilePart' && body.length) refuse(413, 'ed_file_body_forbidden')
    return peer
  }
  return {
    validateRequest,
    siteStatus(binding: { storeId: string; connectionId: string }) {
      return withState(state => {
        if (state.siteBinding && (state.siteBinding.storeId !== binding.storeId || state.siteBinding.connectionId !== binding.connectionId)) refuse(409, 'ed_site_binding_mismatch')
        return { namespace: state.peer.to, pendingDeliveries: state.siteOrders.filter(r => r.messageNo > state.acknowledged).map(r => r.deliveryId), pending: state.acknowledged < state.outbound.length || state.inbound.some(r => !r.applied),
          receipts: state.siteOrders.filter(r => r.messageNo <= state.acknowledged).map(r => ({ deliveryId: r.deliveryId, documentHash: r.documentHash })) }
      })
    },
    queueSiteOrder(binding: { storeId: string; connectionId: string }, delivery: { id: string; xml: string; sha256: string; documentId: string }) {
      return withState((state, save) => {
        if (state.siteBinding && (state.siteBinding.storeId !== binding.storeId || state.siteBinding.connectionId !== binding.connectionId)) refuse(409, 'ed_site_binding_mismatch')
        if (digest(delivery.xml) !== delivery.sha256) refuse(503, 'ed_delivery_corrupt')
        const prior = state.siteOrders.find(r => r.deliveryId === delivery.id)
        if (prior) { if (prior.documentHash !== delivery.sha256) refuse(409, 'ed_site_order_conflict'); return prior }
        if (state.acknowledged !== state.outbound.length || state.inbound.some(r => !r.applied)) refuse(409, 'ed_test_order_exchange_pending')
        if (state.outbound.length >= limits.messages) refuse(507, 'ed_file_message_limit')
        const document = parseXml(Buffer.from('<Body xmlns="' + ED_NS + '">' + delivery.xml + '</Body>'))
        if (document.children.length !== 1 || document.children[0].name !== 'Документ.ЗаказКлиента' || document.children[0].ns !== ED_NS) refuse(422, 'ed_site_document_invalid')
        const keys = child(document.children[0], 'КлючевыеСвойства')
        if (!keys || scalar(keys, 'Ссылка') !== delivery.documentId || !/^[A-Z]{2}\d{9}$/.test(scalar(keys, 'Номер'))) refuse(422, 'ed_site_document_identity_invalid')
        const number = state.outbound.length + 1
        const xml = Buffer.from(envelope({ from: state.peer.to, to: state.peer.from, plan: state.peer.plan, messageNo: number, receivedNo: state.applied }, [delivery.xml], new Date().toISOString(), false, pilotCapabilities(captureOrderSample, directoryEnabled)))
        const zip = writeXmlZip(xml), fileId = randomUUID()
        persistBlob('out-' + fileId + '.zip', zip)
        const entry = { deliveryId: id(delivery.id), documentHash: delivery.sha256, messageNo: number }
        state.siteBinding = binding; state.siteOrders.push(entry)
        state.outbound.push({ number, fileId, zipHash: digest(zip), xmlHash: digest(xml) }); save()
        return entry
      })
    },
    stagedBusinessMessage(fileId: string) {
      return withState(state => {
        const file = id(fileId), upload = state.uploads[file]
        if (!upload?.sealedCount) return refuse(404, 'ed_file_not_sealed')
        const zip = readFileSync(join(dir, 'in-' + file + '.zip'))
        if (digest(zip) !== upload.zipHash) return refuse(503, 'ed_file_archive_corrupt')
        const xml = readXmlZip(zip), m = inspectMessage(xml)
        const prior = state.inbound.find(r => r.sha256 === m.sha256 && r.number === m.confirmation.messageNo)
        if (!prior || !prior.objects) return refuse(409, 'ed_directory_not_staged')
        return { xml, peer: state.peer }
      })
    },
    acceptBusinessMessage(sha256: string) {
      return withState((state, save) => {
        const row = state.inbound.find(r => r.sha256 === sha256)
        if (!row || !row.objects) return refuse(409, 'ed_directory_not_staged')
        if (row.applied) return
        if (row.number !== state.applied + 1 || row.received < state.acknowledged || row.received > state.outbound.length) return refuse(409, 'ed_file_message_counter_invalid')
        row.applied = true; state.applied = row.number; state.acknowledged = row.received; save()
      })
    },
    // Local operator API only: caller validates all orders against the pinned official XSD.
    // Acceptance is for schema research, not import into the commerce database.
    acceptReviewedSample(validation: z.infer<typeof SampleValidation>) {
      if (!captureOrderSample) refuse(409, 'ed_sample_capture_disabled')
      const result = SampleValidation.safeParse(validation)
      if (!result.success) return refuse(422, 'ed_sample_validation_invalid')
      const proof = result.data
      return withState((state, save) => {
        const priorReview = state.sampleReviews.find(r => r.sha256 === proof.sha256)
        if (priorReview) {
          if (priorReview.ordersValidated !== proof.ordersValidated) refuse(409, 'ed_sample_review_conflict')
          return priorReview
        }
        const pending = state.inbound.find(r => r.sha256 === proof.sha256)
        if (!pending || pending.applied || !pending.objects) return refuse(409, 'ed_sample_pending_required')
        if (pending.number !== state.applied + 1 || pending.received < state.acknowledged || pending.received > state.outbound.length) refuse(409, 'ed_file_message_counter_invalid')
        const xml = readFileSync(join(dir, 'message-' + proof.sha256 + '.xml'))
        const message = inspectMessage(xml), c = message.confirmation
        if (message.sha256 !== proof.sha256) refuse(503, 'ed_sample_bytes_changed')
        if (message.format !== ED_NS || !message.hasBody || c.from !== state.peer.from || c.to !== state.peer.to || c.plan !== state.peer.plan || c.messageNo !== pending.number || c.receivedNo !== pending.received) refuse(409, 'ed_sample_message_mismatch')
        if (message.objects.length !== proof.ordersValidated || pending.objects !== proof.ordersValidated || message.objects.some(o => o.ns !== ED_NS || o.name !== 'Документ.ЗаказКлиента')) refuse(422, 'ed_sample_objects_mismatch')
        const review = { ...proof, reviewedAt: new Date().toISOString(), businessImported: false as const }
        state.sampleReviews.push(review)
        pending.applied = true; state.applied = pending.number; state.acknowledged = pending.received
        save() // Commit receipt and counters together. Preserve original and pending outgoing bytes.
        return review
      })
    },
    // Local operator only. validateXml must fail closed on the official order XSD.
    queueNativeTestOrder(value: unknown, evidence: NativeEvidence, validateXml: (xml: Buffer) => void) {
      if (!captureOrderSample) refuse(409, 'ed_sample_capture_disabled')
      const input = OrderInputSchema.parse(value), requestHash = requestDigest(input)
      const verified = validateNativeReferences(input, evidence), terms = verified.terms
      return withState((state, save) => {
        const prior = state.testOrders.find(o => o.key === input.requestKey)
        if (prior) {
          if (prior.requestHash !== requestHash || prior.evidenceHash !== verified.sourceDigest) refuse(409, 'ed_test_order_conflict')
          return { ...prior, reused: true }
        }
        if (state.testOrders.length) refuse(409, 'ed_single_test_order_limit')
        if (state.acknowledged !== state.outbound.length || state.inbound.some(r => !r.applied)) refuse(409, 'ed_test_order_exchange_pending')
        if (state.outbound.length >= limits.messages) refuse(507, 'ed_file_message_limit')
        const documentId = documentUuid(state.peer.to, terms.orderId)
        if (documentId === verified.originalDocumentId) refuse(409, 'ed_test_order_existing_reference')
        const number = state.outbound.length + 1, queuedAt = new Date().toISOString()
        const xml = Buffer.from(envelope({ from: state.peer.to, to: state.peer.from, plan: state.peer.plan, messageNo: number, receivedNo: state.applied }, [renderOrder(input, documentId)], queuedAt, false, pilotCapabilities(captureOrderSample, directoryEnabled)))
        validateXml(xml) // Validate exact routed bytes before any queue mutation.
        const zip = writeXmlZip(xml), fileId = randomUUID(), xmlHash = digest(xml)
        persistBlob('out-' + fileId + '.zip', zip)
        const entry = { key: input.requestKey, requestHash, evidenceHash: verified.sourceDigest, provenance: verified.provenance, originalDocumentId: verified.originalDocumentId, orderId: terms.orderId, number: terms.number, documentId, messageNo: number, xmlHash, queuedAt }
        state.testOrders.push(entry)
        state.outbound.push({ number, fileId, zipHash: digest(zip), xmlHash })
        save() // Same journal and lock as the live HTTP protocol. No parallel counters.
        return { ...entry, reused: false }
      })
    },
    handle(operation: string, q: URLSearchParams, body: Buffer = Buffer.alloc(0)): FileReply {
      const peer = validateRequest(operation, q, body)
      return withState((state, save) => {
        if (operation === 'PutFilePart') {
          const session = id(q.get('SessionID')), part = integer(q.get('PartNumber'), 16)
          if (!body.length || body.length > CHUNK) refuse(413, 'ed_file_part_size')
          if (!state.uploads[session]) {
            if (Object.keys(state.uploads).length >= limits.sessions) refuse(507, 'ed_file_session_limit')
            state.uploads[session] = { parts: {} }
          }
          const upload = state.uploads[session], sha = digest(body), prior = upload.parts[String(part)]
          if (prior && prior !== sha || upload.sealedCount && !prior) refuse(409, 'ed_file_part_conflict')
          persistBlob('part-' + session + '-' + part, body)
          upload.parts[String(part)] = sha; save(); return { body: '', type: 'text' }
        }
        if (operation === 'SaveFileFromParts') {
          const session = id(q.get('SessionID')), count = integer(q.get('PartCount'), 16), upload = state.uploads[session]
          if (!upload || Object.keys(upload.parts).length !== count || upload.sealedCount && upload.sealedCount !== count) refuse(409, 'ed_file_parts_incomplete')
          const buffers: Buffer[] = []
          for (let i = 1; i <= count; i++) {
            if (!upload.parts[String(i)]) refuse(409, 'ed_file_parts_incomplete')
            const buffer = readFileSync(join(dir, 'part-' + session + '-' + i))
            if (digest(buffer) !== upload.parts[String(i)]) refuse(503, 'ed_file_part_corrupt')
            buffers.push(buffer)
          }
          const zip = Buffer.concat(buffers)
          if (zip.length > MAX_ZIP_BYTES) refuse(413, 'ed_file_archive_too_large')
          readXmlZip(zip) // Reject invalid archives before publishing a file ID.
          persistBlob('in-' + session + '.zip', zip)
          upload.sealedCount = count; upload.zipHash = digest(zip); save(); return json({ FileID: session })
        }
        if (operation === 'DownloadData' || operation === 'PutMessageForDataMatching') {
          const fileId = id(q.get('FileID')), upload = state.uploads[fileId]
          if (!upload?.sealedCount) refuse(404, 'ed_file_not_sealed')
          const zip = readFileSync(join(dir, 'in-' + fileId + '.zip'))
          if (digest(zip) !== upload.zipHash) refuse(503, 'ed_file_archive_corrupt')
          const xml = readXmlZip(zip), m = inspectMessage(xml), c = m.confirmation
          if (m.format !== ED_NS || !m.hasBody || c.messageNo < 1) refuse(422, 'ed_file_message_unsupported')
          if (c.from !== peer.from || c.to !== peer.to || c.plan !== peer.plan) refuse(409, 'ed_file_message_peer_mismatch')
          const prior = state.inbound.find(r => r.number === c.messageNo)
          if (prior && prior.sha256 !== m.sha256) refuse(409, 'ed_file_message_conflict')
          if (!prior) {
            if (c.messageNo !== state.applied + 1 || c.receivedNo < state.acknowledged || c.receivedNo > state.outbound.length) refuse(409, 'ed_file_message_counter_invalid')
            if (state.inbound.length >= limits.messages) refuse(507, 'ed_file_message_limit')
            persistBlob('message-' + m.sha256 + '.xml', xml)
            const applied = m.objects.length === 0
            state.inbound.push({ number: c.messageNo, received: c.receivedNo, sha256: m.sha256, objects: m.objects.length, applied })
            if (applied) { state.applied = c.messageNo; state.acknowledged = c.receivedNo }
            save()
          }
          if (m.objects.length && !state.inbound.find(r => r.sha256 === m.sha256)?.applied) refuse(422, 'ed_business_payload_saved_not_applied')
          return operation === 'DownloadData' ? json({ TimeConsumingOperation: false, OperationID: null }) : { body: '', type: 'text' }
        }
        if (operation === 'UploadData') {
          let packet = state.outbound.at(-1)
          if (!packet || state.acknowledged >= packet.number) {
            if (state.outbound.length >= limits.messages) refuse(507, 'ed_file_message_limit')
            const number = state.outbound.length + 1
            const xml = Buffer.from(envelope({ from: peer.to, to: peer.from, plan: peer.plan, messageNo: number, receivedNo: state.applied }, [], new Date().toISOString(), false, pilotCapabilities(captureOrderSample, directoryEnabled)))
            const zip = writeXmlZip(xml), fileId = randomUUID()
            persistBlob('out-' + fileId + '.zip', zip)
            packet = { number, fileId, zipHash: digest(zip), xmlHash: digest(xml) }
            state.outbound.push(packet); save()
          }
          return json({ TimeConsumingOperation: false, OperationID: null, FileID: packet.fileId })
        }
        if (operation === 'PrepareGetFile') {
          const fileId = id(q.get('FileID')), block = integer(q.get('BlockSize'), 1024) * 1024
          const packet = state.outbound.find(p => p.fileId === fileId)
          if (!packet) return refuse(404, 'ed_file_outbound_missing')
          const zip = readFileSync(join(dir, 'out-' + fileId + '.zip'))
          if (digest(zip) !== packet.zipHash) refuse(503, 'ed_file_archive_corrupt')
          let session = Object.keys(state.reads).find(key => { const r = state.reads[key]; return r.fileId === fileId && r.block === block && !r.released })
          if (!session) {
            if (Object.keys(state.reads).length >= limits.reads) refuse(507, 'ed_file_session_limit')
            session = randomUUID(); state.reads[session] = { fileId, block, released: false }; save()
          }
          return json({ SessionID: session, PartCount: Math.ceil(zip.length / block) })
        }
        const session = id(q.get('SessionID')), read = state.reads[session]
        if (!read) refuse(404, 'ed_file_read_session_missing')
        if (operation === 'ReleaseFile') {
          read.released = true; save(); return { body: '', type: 'text' } // Does not delete payload or acknowledge a document.
        }
        if (read.released) refuse(410, 'ed_file_read_session_released')
        const part = integer(q.get('PartNumber'), 16384), packet = state.outbound.find(p => p.fileId === read.fileId)!
        const zip = readFileSync(join(dir, 'out-' + read.fileId + '.zip'))
        if (digest(zip) !== packet.zipHash) refuse(503, 'ed_file_archive_corrupt')
        const start = (part - 1) * read.block
        if (start >= zip.length) refuse(416, 'ed_file_part_out_of_range')
        return { body: zip.subarray(start, Math.min(start + read.block, zip.length)), type: 'binary' }
      })
    },
  }
}
export type FileTransport = ReturnType<typeof openFileTransport>
