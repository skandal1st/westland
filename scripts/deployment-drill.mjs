// Linux controller + real production Compose/Next image; owns only uniquely named resources.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
const image = process.argv[2]
if (!/^sha256:[a-f0-9]{64}$/.test(image || '')) throw Error('Usage: node scripts/deployment-drill.mjs sha256:<exact image ID>')
const root = process.cwd(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-r37-driver-'))
const name = 'axima-r37-driver-' + crypto.randomBytes(6).toString('hex'), volume = name + '-data'
const run = args => execFileSync('docker', args, { windowsHide: true, timeout: 300_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:22-bookworm-slim\nCOPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker\nCOPY --from=docker:27-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins\n')
let created = false
try {
  run(['build', '--iidfile', path.join(dir, 'iid'), dir]); const driver = fs.readFileSync(path.join(dir, 'iid'), 'utf8').trim()
  run(['volume', 'create', volume]); created = true
  const mount = run(['volume', 'inspect', '--format', '{{.Mountpoint}}', volume])
  console.log('Linux deployment drill: ' + name)
  const args = ['run', '--name', name, '--mount', 'type=bind,source=' + root + ',target=/source,readonly', '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
    '--mount', 'type=volume,source=' + volume + ',target=' + mount, '-e', 'TMPDIR=' + mount, '-e', 'AXIMA_DRILL_SOURCE=/source', '--workdir', '/source',
    driver, 'node', 'tests/deployment/image-drill.mjs', image]
  let output = ''
  const code = await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    const log = fs.createWriteStream(path.join(dir, 'drill.log'))
    child.stdout.on('data', data => { output += data.toString(); process.stdout.write(data); log.write(data) })
    child.on('error', reject); child.on('close', code => { log.end(); resolve(code) })
  })
  if (code !== 0) throw Error('Linux deployment drill failed; private volume retained: ' + volume)
  const resultLine = output.split(/\r?\n/).find(line => line.startsWith('R37_RESULT '))
  const report = resultLine ? JSON.parse(resultLine.slice('R37_RESULT '.length)) : null
  if (!report || report.status !== 'PASS' || report.platform !== 'linux' || report.cleanupFailed || !Array.isArray(report.stages) || report.stages.length < 10 || report.stages.some(stage => stage.status !== 'PASS')) throw Error('Missing or incomplete R37 evidence')
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(report, null, 2))
  run(['rm', name]); run(['volume', 'rm', volume]); created = false
  console.log('R37 Linux drill PASS; evidence: ' + dir)
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally { if (created) console.error('Diagnostic container/volume retained: ' + name + ' / ' + volume) }
