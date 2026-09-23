import { pilotJsonCapabilities } from './capabilities'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { digest, ED_VERSION, FORMAT_BASE } from './message'

export const ED_PLAN = 'СинхронизацияДанныхЧерезУниверсальныйФормат'
const plans = new Set([ED_PLAN, 'DataSynchronizationViaUniversalFormat'])
const code = z.string().min(1).max(64).regex(/^[A-Za-zА-Яа-яЁё0-9_-]+$/)
const versionList = z.array(z.string().regex(/^\d+\.\d+$/)).max(100)
const capabilities = z.array(z.object({ Object: z.string().min(1).max(160), Send: z.union([z.literal('*'), versionList]), Receive: z.union([z.literal('*'), versionList]) })).max(2000)
const SetupSchema = z.object({
  MainExchangeParameters: z.object({
    FormatVersion: z.literal('2.0'), NodeCode: code, CorrespondentNodeCode: code,
    ExchangePlanName: z.string().refine(v => plans.has(v)), CorrespondentExchangePlanName: z.string().refine(v => plans.has(v)),
    SentNo: z.literal(0), ReceivedNo: z.literal(0), ExchangeFormatVersions: versionList,
    TransportID: z.literal('HTTP'),
    SourceInfobasePrefix: z.string().max(16), DestinationInfobasePrefix: z.string().max(16),
    ThisInfobaseDescription: z.string().max(512), SecondInfobaseDescription: z.string().max(512),
  }),
  XDTOExchangeParameters: z.object({ ExchangeFormat: z.literal(FORMAT_BASE) }),
  SupportedObjectsInFormat: capabilities,
}) // Explicit allowlist: never persist TransportSettings, credentials or unknown fields.
const IdentitySchema = z.object({ nodeCode: z.string().uuid(), prefix: z.literal('AX'), description: z.literal('AXIMA EnterpriseData TEST') }).strict()
const SavedSchema = z.object({ version: z.literal(1), createdAt: z.string().datetime(), setup: SetupSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export class SetupError extends Error { constructor(public status: number, public code: string) { super(code) } }
const reject = (status: number, code: string): never => { throw new SetupError(status, code) }
function atomic(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID() + '.tmp', fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
}
function withLock<T>(dir: string, work: () => T) {
  const path = join(dir, '.setup.lock'); let fd: number
  try { fd = openSync(path, 'wx', 0o600) } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return reject(409, 'ed_setup_busy')
    throw e
  }
  try { return work() } finally { closeSync(fd); unlinkSync(path) }
}
/** SSL HTTP onboarding, not a business importer. Wire Send/Receive are recipient-facing:
 * reference transport-common.bsl:2319 swaps local Отправка/Получение during JSON serialization.
 */
export function openHttpSetup(dir: string, captureOrderSample = false, directoryEnabled = false) {
  mkdirSync(dir, { recursive: true })
  const identityPath = join(dir, 'identity.json'), setupPath = join(dir, 'peer-setup.json')
  const identity = withLock(dir, () => {
    if (!existsSync(identityPath)) atomic(identityPath, { nodeCode: randomUUID(), prefix: 'AX', description: 'AXIMA EnterpriseData TEST' })
    return IdentitySchema.parse(JSON.parse(readFileSync(identityPath, 'utf8')))
  })
  function saved() {
    if (!existsSync(setupPath)) return null
    const record = SavedSchema.parse(JSON.parse(readFileSync(setupPath, 'utf8')))
    if (digest(JSON.stringify(record.setup)) !== record.hash || record.setup.MainExchangeParameters.CorrespondentNodeCode !== identity.nodeCode) return reject(503, 'ed_setup_storage_invalid')
    return record
  }
  return {
    parameters(query: URLSearchParams) {
      const known = new Set(['ExchangePlanName', 'NodeCode', 'IsXDTOExchangePlan', 'SettingID'])
      for (const key of Array.from(query.keys())) if (!known.has(key) || query.getAll(key).length !== 1) reject(400, 'ed_setup_query_invalid')
      const plan = query.get('ExchangePlanName') ?? '', node = code.safeParse(query.get('NodeCode'))
      if (!plans.has(plan) || !node.success || (query.get('SettingID')?.length ?? 0) > 256) reject(400, 'ed_setup_query_invalid')
      if (node.data === identity.nodeCode) reject(409, 'ed_setup_same_node')
      const record = saved()
      if (record && record.setup.MainExchangeParameters.NodeCode !== node.data) reject(409, 'ed_setup_peer_mismatch')
      return {
        ExchangePlanExists: true, InfobasePrefix: identity.prefix, DefaultInfobasePrefix: identity.prefix,
        InfobaseDescription: identity.description, DefaultInfobaseDescription: identity.description,
        AccountingParametersSettingsAreSpecified: !!record, ThisNodeCode: identity.nodeCode,
        ConfigurationVersion: '0.1.0.0', NodeExists: !!record, DataExchangeSettingsFormatVersion: '2.0',
        UsePrefixesForExchangeSettings: false, ExchangeFormat: FORMAT_BASE, ExchangePlanName: ED_PLAN,
        ExchangeFormatVersions: [ED_VERSION], DataSynchronizationSetupCompleted: false,
        MessageReceivedForDataMapping: false, DataMappingSupported: false,
        // Directions are relative to the caller (1C); directory reception is opt-in.
        SupportedObjectsInFormat: pilotJsonCapabilities(captureOrderSample, directoryEnabled),
      }
    },
    peer() {
      const record = saved()
      if (!record) return reject(409, 'ed_setup_peer_required')
      const m = record.setup.MainExchangeParameters
      return { from: m.NodeCode, to: m.CorrespondentNodeCode, plan: m.ExchangePlanName }
    },
    create(value: unknown) {
      const parsed = SetupSchema.safeParse(value)
      if (!parsed.success) return reject(400, 'ed_setup_contract_invalid')
      const setup = parsed.data, main = setup.MainExchangeParameters
      if (main.CorrespondentNodeCode !== identity.nodeCode || main.NodeCode === identity.nodeCode) reject(409, 'ed_setup_destination_mismatch')
      if (!main.ExchangeFormatVersions.includes(ED_VERSION)) reject(422, 'ed_setup_version_unsupported')
      if (new Set(main.ExchangeFormatVersions).size !== main.ExchangeFormatVersions.length
        || new Set(setup.SupportedObjectsInFormat.map(o => o.Object)).size !== setup.SupportedObjectsInFormat.length) reject(400, 'ed_setup_duplicate_capabilities')
      const order = setup.SupportedObjectsInFormat.find(o => o.Object === 'Документ.ЗаказКлиента')
      // Incoming settings have already been reversed for their recipient (this adapter).
      if (!order || !(order.Send === '*' || order.Send.includes(ED_VERSION))) reject(422, 'ed_setup_order_receiving_unsupported')
      const hash = digest(JSON.stringify(setup))
      return withLock(dir, () => {
        const previous = saved()
        if (previous) {
          if (previous.hash !== hash) reject(409, 'ed_setup_already_bound')
          return { reused: true }
        }
        atomic(setupPath, { version: 1, createdAt: new Date().toISOString(), setup, hash })
        return { reused: false }
      })
    },
  }
}
export type HttpSetup = ReturnType<typeof openHttpSetup>
