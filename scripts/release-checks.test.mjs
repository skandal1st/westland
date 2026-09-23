import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertCompleteTests, runCommand, summarize, requiredStages } from './release-checks-lib.mjs'
const pass = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, testResults: [{ assertionResults: [{ status: 'passed' }] }] }
test('a real complete passing report is accepted', () => assert.equal(assertCompleteTests(pass), 1))
test('SKIP/TODO/empty/incomplete reports cannot give PASS', () => {
  for (const patch of [{ success: false }, { numPendingTests: 1 }, { numTodoTests: 1 }, { numTotalTests: 0 }, { testResults: [] }, { numPassedTests: 0 }, { testResults: [{ assertionResults: [{ status: 'skipped' }] }] }]) assert.throws(() => assertCompleteTests({ ...pass, ...patch }))
})
test('Docker/child failures and missing commands propagate', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.exit(7)']), /failed: 7/)
  await assert.rejects(runCommand('axima-command-that-does-not-exist', []))
})
test('timeouts fail instead of passing', async () => await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), /timeout/))
test('passing local checks never imply deployment acceptance', () => {
  const passed = requiredStages.map(name => ({ name, status: 'PASS' }))
  assert.equal(summarize(passed).checks, 'PASS')
  assert.equal(summarize(passed).releaseApproved, false)
  assert.equal(summarize(passed).deploymentGates.some(gate => gate.startsWith('R37:')), false)
  assert.equal(summarize(passed.filter(stage => stage.name !== 'deployment-drill')).deploymentGates.some(gate => gate.startsWith('R37:')), true)
  assert.equal(summarize(passed.filter(stage => stage.name !== 'docker-runtime')).checks, 'FAIL')
  assert.equal(summarize([...passed, passed[0]]).checks, 'FAIL')
  assert.equal(summarize([{ status: 'NOT_RUN' }]).checks, 'FAIL')
  assert.equal(summarize([]).checks, 'FAIL')
})

test('timeout stops subprocess writers, not just their parent', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-timeout-test-'))
  const ready = path.join(root, 'ready'), marker = path.join(root, 'late-write')
  try {
    const writer = "const fs=require('node:fs');fs.writeFileSync(" + JSON.stringify(ready) + ",'ready');setTimeout(()=>fs.writeFileSync(" + JSON.stringify(marker) + ",'unexpected'),1800)"
    const parent = "require('node:child_process').spawn(process.execPath,['-e'," + JSON.stringify(writer) + "],{windowsHide:true});setInterval(()=>{},1000)"
    await assert.rejects(runCommand(process.execPath, ['-e', parent], { timeout: 700 }), /timeout/)
    assert.ok(fs.existsSync(ready), 'writer really started')
    await new Promise(resolve => setTimeout(resolve, 1900))
    assert.equal(fs.existsSync(marker), false, 'writer must not survive the failed stage')
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('axima-timeout-test-')) throw new Error('Unsafe cleanup')
    fs.rmSync(root, { recursive: true, force: true })
  }
})
