/** Queue a single new test order using reviewed user-supplied native XML. Local operator only. */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { openFileTransport } from '../src/lib/integrations/enterprisedata/http-files'
import { openHttpSetup, SetupError } from '../src/lib/integrations/enterprisedata/http-setup'
import { digest, EnterpriseDataError } from '../src/lib/integrations/enterprisedata/message'
const schemaHash = '73f126576f9947626b8b9a6da7306ff04223408bc235627fbc61a20899f6c8fb'
try {
  if (process.argv.length !== 8) throw new Error('arguments')
  const [configPath, inputPath, nativeDir, python, edSchema, messageSchema] = process.argv.slice(2)
  const config = z.object({ setupEnabled: z.literal(true), filesEnabled: z.literal(true), captureOrderSample: z.literal(true) }).parse(JSON.parse(readFileSync(resolve(configPath), 'utf8').replace(/^\uFEFF/, '')))
  const dir = dirname(resolve(configPath)), read = (name: string) => readFileSync(join(resolve(nativeDir), name))
  const input: unknown = JSON.parse(readFileSync(resolve(inputPath), 'utf8'))
  const evidence = { order: read('order.xml'), counterparty: read('counterparty.xml'), organization: read('organization.xml'), product: read('product.xml'), confirmation: read('user-confirmation.json') }
  const setup = openHttpSetup(join(dir, 'onboarding'), config.captureOrderSample)
  const transport = openFileTransport(join(dir, 'files'), () => setup.peer(), config.captureOrderSample)
  const result = transport.queueNativeTestOrder(input, evidence, xml => {
    if (digest(readFileSync(resolve(edSchema))) !== schemaHash) throw new Error('unexpected schema')
    const sha256 = digest(xml), candidates = join(dir, 'test-order-candidates')
    mkdirSync(candidates, { recursive: true })
    const path = join(candidates, sha256 + '.xml')
    if (existsSync(path)) { if (digest(readFileSync(path)) !== sha256) throw new Error('candidate changed') }
    else writeFileSync(path, xml, { flag: 'wx', mode: 0o600 })
    const validation = spawnSync(resolve(python), [resolve('scripts/validate-enterprisedata.py'), '--orders-only', resolve(edSchema), resolve(messageSchema), path], { encoding: 'utf8', maxBuffer: 512 * 1024, timeout: 30000, windowsHide: true })
    if (validation.error || validation.status !== 0) throw new Error('XSD validation failed')
    z.object({ valid: z.literal(true), schemaSha256: z.literal(schemaHash), packets: z.array(z.object({ sha256: z.literal(sha256), ordersValidated: z.literal(1) })).length(1) }).parse(JSON.parse(validation.stdout))
  })
  console.log(JSON.stringify({ status: 'test_order_queued', ...result, edReferenceMappingVerified: false, nativeReferencesVerified: true, oneCAcceptancePending: true }))
} catch (error) {
  console.error(error instanceof SetupError || error instanceof EnterpriseDataError ? error.message : 'ed_test_order_queue_failed')
  process.exitCode = 1
}
