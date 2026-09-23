import fs from 'node:fs'
import { spawn } from 'node:child_process'
export async function runCommand(command, args, { logFile, env = process.env, timeout = 20 * 60_000, cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const log = logFile ? fs.openSync(logFile, 'a') : undefined
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', log ?? 'inherit', log ?? 'inherit'] })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (!child.pid) return
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill())
      } else { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL') } }
    }, timeout)
    const close = () => { clearTimeout(timer); if (log !== undefined) fs.closeSync(log) }
    let spawnError
    child.once('error', error => { spawnError = error })
    child.once('close', (code, signal) => { close(); if (spawnError) reject(spawnError); else if (code === 0 && !timedOut) resolve(); else reject(new Error(command + ' failed: ' + (timedOut ? 'timeout' : signal ?? code))) })
  })
}
export function assertCompleteTests(report) {
  const assertions = report.testResults?.flatMap(result => result.assertionResults ?? []) ?? []
  if (report.success !== true || !Number.isInteger(report.numTotalTests) || report.numTotalTests < 1
    || report.numFailedTests !== 0 || report.numPendingTests !== 0 || (report.numTodoTests ?? 0) !== 0
    || report.numPassedTests !== report.numTotalTests || assertions.length !== report.numTotalTests
    || assertions.some(item => item.status !== 'passed')) throw new Error('Test report is failed, empty, incomplete, or contains SKIP/TODO')
  return report.numPassedTests
}
export const requiredStages = ['prerequisites', 'gate-regressions', 'boundaries', 'lint', 'unit', 'worker-build', 'test-migrations', 'integration-including-replay', 'license-smoke', 'docker-build', 'docker-runtime', 'deployment-drill']
export const deploymentGates = [
  'R37: install/update/failed-update rollback and backup/restore on an isolated installation',
  'R39: exact-image business acceptance, real test ERP, source transition and restart recovery',
]
export function summarize(stages) {
  return { checks: requiredStages.every(name => stages.filter(stage => stage.name === name && stage.status === 'PASS').length === 1) && stages.every(stage => stage.status === 'PASS') ? 'PASS' : 'FAIL',
    releaseApproved: false, deploymentGates: stages.filter(stage => stage.name === 'deployment-drill' && stage.status === 'PASS').length === 1 ? deploymentGates.filter(gate => !gate.startsWith('R37:')) : deploymentGates }
}
