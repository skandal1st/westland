#!/usr/bin/env node
/** Strict local prerequisites. Production/recovery acceptance remains a separate, explicitly blocked gate. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertTestDatabase } from './test-db-guard.mjs'
import { runCommand, assertCompleteTests, summarize, requiredStages } from './release-checks-lib.mjs'
const args = process.argv.slice(2)
if (args.some(arg => arg !== '--acceptance')) throw new Error('Usage: node scripts/release-checks.mjs [--acceptance]')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-release-checks-'))
const env = { ...process.env }
const stages = requiredStages.map(name => ({ name, status: 'NOT_RUN' }))
let imageId = null
const save = () => fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ ...summarize(stages), imageId, stages }, null, 2))
async function step(name, action) {
  const stage = stages.find(item => item.name === name)
  stage.status = 'RUNNING'; stage.startedAt = new Date().toISOString(); save(); console.log('RUN ' + name)
  try { await action(stage); stage.status = 'PASS'; console.log('PASS ' + name) }
  catch (error) { stage.status = 'FAIL'; stage.error = error.message; throw error }
  finally { stage.finishedAt = new Date().toISOString(); save() }
}
const command = (name, bin, argv, extra = {}) => runCommand(bin, argv, { logFile: path.join(dir, name + '.log'), env, ...extra })
const node = (name, argv, extra) => command(name, process.execPath, argv, extra)
const tests = async (name, config) => {
  const report = path.join(dir, name + '.json')
  await node(name, ['node_modules/vitest/vitest.mjs', 'run', '--config', config, '--reporter=default', '--reporter=json', '--outputFile', report], { timeout: 60 * 60_000 })
  stages.find(stage => stage.name === name).passedTests = assertCompleteTests(JSON.parse(fs.readFileSync(report, 'utf8')))
}
console.log('Evidence: ' + dir)
try {
  await step('prerequisites', async () => {
    assertTestDatabase(env)
    if (!env.AXIMA_R16_SOURCE_DIR) throw new Error('AXIMA_R16_SOURCE_DIR required; opt-in replay must not be skipped')
    for (const file of ['import0_1.xml', 'offers0_1.xml', 'database.json', 'derived/controls/import0_1.xml', 'derived/controls/offers0_1.xml', 'derived/mapped-diagnostic/import0_1.xml', 'derived/mapped-diagnostic/offers0_1.xml']) fs.accessSync(path.join(env.AXIMA_R16_SOURCE_DIR, file))
    for (const flag of ['FULL', 'VOLUME', 'PERFORMANCE', 'SKUS', 'NEGATIVES', 'OWNERSHIP']) env['AXIMA_R16_' + flag] = '1'
    await command('prerequisites', 'docker', ['info', '--format', '{{.ServerVersion}}'])
  })
  await step('gate-regressions', () => node('gate-regressions', ['--test', 'scripts/commerce-boundaries.test.mjs', 'scripts/release-checks.test.mjs', 'tests/deployment/deploy.test.mjs', 'tests/deployment/archive-guard.test.mjs', 'tests/deployment/test-db-guard.test.mjs']))
  await step('boundaries', () => node('boundaries', ['scripts/commerce-boundaries.mjs']))
  await step('lint', () => node('lint', ['node_modules/next/dist/bin/next', 'lint']))
  await step('unit', () => tests('unit', 'vitest.config.mts'))
  await step('worker-build', () => node('worker-build', ['scripts/build-worker.mjs']))
  await step('test-migrations', () => node('test-migrations', ['scripts/test-db-setup.mjs']))
  await step('integration-including-replay', () => tests('integration-including-replay', 'vitest.integration.config.mts'))
  await step('license-smoke', () => node('license-smoke', ['scripts/license-smoke.mjs']))
  const iidFile = path.join(dir, 'image-id')
  await step('docker-build', async () => {
    await command('docker-build', 'docker', ['build', '--iidfile', iidFile, '.'])
    imageId = fs.readFileSync(iidFile, 'utf8').trim()
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Missing immutable image ID')
  })
  await step('docker-runtime', () => node('docker-runtime', ['scripts/release-image-smoke.mjs', imageId]))
  await step('deployment-drill', () => node('deployment-drill', ['scripts/deployment-drill.mjs', imageId], { timeout: 60 * 60_000 }))
  console.log('LOCAL RELEASE CHECKS PASSED. This is not deployment acceptance.')
  if (args.includes('--acceptance')) { console.error('ACCEPTANCE BLOCKED: R39 has not been executed by this runner. See result.json.'); process.exitCode = 2 }
} catch (error) {
  console.error('RELEASE CHECKS FAILED: ' + error.message + '. Evidence: ' + dir)
  process.exitCode = 1
} finally { save() }
