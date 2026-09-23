/** Local-only operator command. The HTTP service never invokes this command. */
import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { z } from 'zod'
import { openFileTransport } from '../src/lib/integrations/enterprisedata/http-files'
import { openHttpSetup, SetupError } from '../src/lib/integrations/enterprisedata/http-setup'
try {
  if (process.argv.length !== 7) throw new Error('arguments')
  const [configPath, sha256, python, edSchema, messageSchema] = process.argv.slice(2)
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('digest')
  const config = z.object({ setupEnabled: z.literal(true), filesEnabled: z.literal(true), captureOrderSample: z.literal(true) }).parse(JSON.parse(readFileSync(resolve(configPath), 'utf8').replace(/^\uFEFF/, '')))
  const dir = dirname(resolve(configPath)), files = join(dir, 'files')
  const validation = spawnSync(resolve(python), [resolve('scripts/validate-enterprisedata.py'), '--orders-only', resolve(edSchema), resolve(messageSchema), join(files, 'message-' + sha256 + '.xml')], { encoding: 'utf8', maxBuffer: 512 * 1024, timeout: 30000, windowsHide: true })
  if (validation.error || validation.status !== 0) throw new Error('validation')
  const report = z.object({ valid: z.literal(true), schemaSha256: z.literal('73f126576f9947626b8b9a6da7306ff04223408bc235627fbc61a20899f6c8fb'), packets: z.array(z.object({ sha256: z.literal(sha256), ordersValidated: z.number().int().positive() })).length(1) }).parse(JSON.parse(validation.stdout))
  const setup = openHttpSetup(join(dir, 'onboarding'), config.captureOrderSample)
  const transport = openFileTransport(files, () => setup.peer(), config.captureOrderSample)
  const review = transport.acceptReviewedSample({ sha256, schemaSha256: report.schemaSha256, ordersValidated: report.packets[0].ordersValidated, purpose: 'schema-sample-only' })
  console.log(JSON.stringify({ status: 'sample_reviewed', ...review }))
} catch (error) {
  console.error(error instanceof SetupError ? error.message : 'ed_sample_review_failed')
  process.exitCode = 1
}
