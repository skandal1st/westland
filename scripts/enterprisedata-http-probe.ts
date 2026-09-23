import { siteTransport } from '../src/lib/integrations/enterprisedata/site-transport'
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { z } from 'zod'
import { openFileTransport } from '../src/lib/integrations/enterprisedata/http-files'
import { openHttpSetup } from '../src/lib/integrations/enterprisedata/http-setup'
import { createEnterpriseDataProbe } from '../src/lib/integrations/enterprisedata/http-probe'
import { appendTransportAudit } from '../src/lib/integrations/enterprisedata/audit'
import { requireEdSource } from '../src/lib/integrations/enterprisedata/site-orders'
import { assertCapability } from '../src/lib/capabilities'
import { prisma } from '../src/lib/db'

const Config = z.object({ username: z.string(), password: z.string(), basePath: z.string(), port: z.number().int().min(1024).max(65535), setupEnabled: z.boolean().default(false), filesEnabled: z.boolean().default(false), captureOrderSample: z.boolean().default(false), directoryEnabled: z.boolean().default(false), listenHost: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'), site: z.object({ storeId: z.string().min(1), connectionId: z.string().min(1) }).strict().optional() }).strict()

async function main() {
  const args = process.argv.slice(2), health = args[1] === '--health'
  if (!args[0] || args.length > 2 || args.length === 2 && !health) throw new Error('config argument required')
  const path = resolve(args[0]), config = Config.parse(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')))
  // Config can be read-only; persistent protocol state lives with the backed-up exchange volume.
  const stateDir = resolve(process.env.ED_STATE_DIR ?? dirname(path))
  if (health) {
    accessSync(stateDir, constants.R_OK | constants.W_OK)
    if (config.site) { assertCapability('commerce-core'); await requireEdSource(config.site) }
    const response = await fetch('http://127.0.0.1:' + config.port + config.basePath + '/hs/exchange_dsl_1_0_0_1/version', {
      headers: { authorization: 'Basic ' + Buffer.from(config.username + ':' + config.password).toString('base64') },
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok || await response.text() !== '1') throw new Error('transport unavailable')
    await prisma.$disconnect()
    return
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const listenHost = z.enum(['127.0.0.1', '0.0.0.0']).parse(process.env.ED_LISTEN_HOST ?? config.listenHost)
  const setup = config.setupEnabled ? openHttpSetup(join(stateDir, 'onboarding'), config.captureOrderSample, config.directoryEnabled) : undefined
  if (config.captureOrderSample && !config.filesEnabled) throw new Error('file transport required for sample capture')
  if (config.filesEnabled && !setup) throw new Error('setup required')
  const files = config.filesEnabled ? openFileTransport(join(stateDir, 'files'), () => setup!.peer(), config.captureOrderSample, config.site ? { messages: 10000, sessions: 10000, reads: 20000, quota: 512 * 1024 * 1024 } : undefined, config.directoryEnabled) : undefined
  if (config.directoryEnabled && !config.site) throw new Error('directory requires site binding')
  if (config.site && !files) throw new Error('site transport requires files')
  const server = createEnterpriseDataProbe({ ...config, setup, files: config.site && files ? siteTransport(files, config.site, undefined, config.directoryEnabled) : files,
    audit: event => appendTransportAudit(join(stateDir, 'probe-audit.jsonl'), event),
  })
  server.on('error', () => { console.error('ed_transport_listen_failed'); process.exitCode = 1 })
  server.listen(config.port, listenHost, () => console.log('ed_transport_listening'))
  const stop = () => server.close(() => { void prisma.$disconnect().then(() => { process.exitCode = 0 }) })
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
}
main().catch(async () => { console.error('ed_transport_configuration_or_health_failed'); await prisma.$disconnect(); process.exitCode = 1 })
