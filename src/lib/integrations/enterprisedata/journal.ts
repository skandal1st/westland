import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { digest, ED_VERSION, FORMAT_BASE, envelope, fail, inspectMessage, type Confirmation } from './message'
import { documentUuid, OrderInputSchema, renderOrder, requestDigest, validateReferences } from './order'

const EntrySchema = z.object({ key: z.string(), requestHash: z.string(), orderId: z.string(), number: z.string(), documentId: z.string().uuid(), messageNo: z.number().int().positive(), xml: z.string(), sha256: z.string() }).strict()
const StateSchema = z.object({
  version: z.literal(1), testOnly: z.literal(true), namespace: z.string().uuid(), settingsHash: z.string(),
  peer: z.object({ from: z.string(), to: z.string(), plan: z.string() }).strict(),
  settingsReply: z.string(), sent: z.number().int().nonnegative(), acknowledged: z.number().int().nonnegative(),
  entries: z.array(EntrySchema).max(10), receipts: z.array(z.object({ messageNo: z.number().int().positive(), receivedNo: z.number().int().nonnegative(), sha256: z.string() }).strict()).max(100),
}).strict()
type State = z.infer<typeof StateSchema>
const statePath = (dir: string) => join(dir, 'journal.json')
function locked<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, '.lock')
  let fd: number
  try { fd = openSync(path, 'wx', 0o600) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return fail('ed_journal_locked')
    throw e
  }
  try { writeFileSync(fd, String(process.pid)); return fn() }
  finally { closeSync(fd); unlinkSync(path) }
}
function save(dir: string, value: State) {
  const temporary = join(dir, 'journal.' + randomUUID() + '.tmp')
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(StateSchema.parse(value), null, 2)); fsyncSync(fd) }
  finally { closeSync(fd) }
  // Persist counters and exact bytes together before making an export available.
  renameSync(temporary, statePath(dir))
}
function read(dir: string) {
  const state = StateSchema.parse(JSON.parse(readFileSync(statePath(dir), 'utf8')))
  if (state.sent !== state.entries.length || state.acknowledged > state.sent) fail('ed_journal_corrupt')
  const reply = inspectMessage(Buffer.from(state.settingsReply))
  if (reply.confirmation.from !== state.peer.to || reply.confirmation.to !== state.peer.from || reply.confirmation.plan !== state.peer.plan) fail('ed_journal_corrupt')
  state.entries.forEach((entry, index) => {
    const c = inspectMessage(Buffer.from(entry.xml)).confirmation
    if (entry.messageNo !== index + 1 || entry.sha256 !== digest(entry.xml) || c.messageNo !== entry.messageNo || c.receivedNo !== 0
      || c.from !== state.peer.to || c.to !== state.peer.from || c.plan !== state.peer.plan) fail('ed_journal_corrupt')
  })
  return state
}
function outgoing(state: State, messageNo: number): Confirmation {
  // No incoming business data is applied by this pilot. Never acknowledge it.
  return { plan: state.peer.plan, from: state.peer.to, to: state.peer.from, messageNo, receivedNo: 0 }
}
export function initializeJournal(dir: string, settings: Buffer, now = new Date().toISOString()) {
  return locked(dir, () => {
    const m = inspectMessage(settings), c = m.confirmation
    if (m.format !== FORMAT_BASE || m.hasBody || c.messageNo !== 0 || c.receivedNo !== 0) fail('ed_settings_required')
    if (!m.versions.includes(ED_VERSION)) fail('ed_version_not_supported')
    if (m.hasObjectTypes) {
      const order = m.objectTypes.find(t => t.name === 'Документ.ЗаказКлиента')
      if (!order || !order.receiving.split(/[;,\s]+/).some(v => v === '*' || v === ED_VERSION)) fail('ed_peer_cannot_receive_order')
    }
    if (existsSync(statePath(dir))) {
      const previous = read(dir)
      if (previous.settingsHash !== m.sha256) fail('ed_journal_already_initialized')
      return { xml: previous.settingsReply, reused: true }
    }
    const peer = { plan: c.plan, from: c.from, to: c.to }
    const state: State = { version: 1, testOnly: true, namespace: randomUUID(), peer, settingsHash: m.sha256,
      settingsReply: '', sent: 0, acknowledged: 0, entries: [], receipts: [] }
    state.settingsReply = envelope(outgoing(state, 0), [], now, true)
    save(dir, state)
    return { xml: state.settingsReply, reused: false }
  })
}
export function prepareOrder(dir: string, value: unknown, evidence: Buffer, now = new Date().toISOString()) {
  return locked(dir, () => {
    const state = read(dir), input = OrderInputSchema.parse(value), requestHash = requestDigest(input)
    const terms = validateReferences(input, evidence, state.peer)
    const prior = state.entries.find(e => e.key === input.requestKey)
    if (prior) {
      if (prior.requestHash !== requestHash) fail('ed_idempotency_conflict')
      return { ...prior, reused: true }
    }
    if (state.entries.some(e => e.orderId === terms.orderId || e.number === terms.number)) fail('ed_duplicate_document')
    if (state.sent !== state.acknowledged) fail('ed_previous_message_unacknowledged')
    if (state.entries.length >= 10) fail('ed_pilot_limit')
    const id = documentUuid(state.namespace, terms.orderId), messageNo = state.sent + 1
    const xml = envelope(outgoing(state, messageNo), [renderOrder(input, id)], now)
    const entry = { key: input.requestKey, requestHash, orderId: terms.orderId, number: terms.number, documentId: id, messageNo, xml, sha256: digest(xml) }
    state.entries.push(entry); state.sent = messageNo; save(dir, state)
    return { ...entry, reused: false }
  })
}
export function recordReceipt(dir: string, bytes: Buffer) {
  return locked(dir, () => {
    const state = read(dir), m = inspectMessage(bytes), c = m.confirmation
    if (c.from !== state.peer.from || c.to !== state.peer.to || c.plan !== state.peer.plan) fail('ed_receipt_source_mismatch')
    if (c.messageNo < 1 || !m.hasBody || m.format !== FORMAT_BASE + '/' + ED_VERSION) fail('ed_receipt_message_required')
    const prior = state.receipts.find(r => r.messageNo === c.messageNo)
    if (prior) {
      if (prior.sha256 !== m.sha256) fail('ed_receipt_conflict')
      return { acknowledged: state.acknowledged, receivedObjectsNotApplied: m.objects.length, reused: true }
    }
    if (c.messageNo <= (state.receipts.at(-1)?.messageNo ?? 0) || c.receivedNo < state.acknowledged || c.receivedNo > state.sent) fail('ed_receipt_counter_invalid')
    if (state.receipts.length >= 100) fail('ed_pilot_limit')
    state.receipts.push({ messageNo: c.messageNo, receivedNo: c.receivedNo, sha256: m.sha256 })
    state.acknowledged = c.receivedNo; save(dir, state)
    return { acknowledged: state.acknowledged, receivedObjectsNotApplied: m.objects.length, reused: false }
  })
}
export function journalStatus(dir: string) {
  const s = read(dir)
  return { testOnly: true, sent: s.sent, acknowledged: s.acknowledged, incomingApplied: 0,
    orders: s.entries.map(({ number, documentId, messageNo, sha256 }) => ({ number, documentId, messageNo, sha256 })) }
}
