#!/usr/bin/env node
// Only installation identity and licensing. Does not claim database/recovery/deployment acceptance.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { generateInstallationIdentity } from '../packages/license-core/index.mjs'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-license-smoke-'))
const keys = path.join(root, 'keys'), data = path.join(root, 'licenses.json'), deployment = path.join(root, 'deployment')
const node = (args, env = process.env) => execFileSync(process.execPath, args, { env, windowsHide: true, timeout: 30_000, encoding: 'utf8' })
let server
try {
  node(['services/license-server/keygen.mjs', keys])
  const activation = node(['services/license-server/issue.mjs', '--data', data, '--customer', 'release-smoke', '--modules', 'commerce-core,commerce-b2b,content,invoices']).trim().split(/\r?\n/).at(-1)
  const port = await new Promise((resolve, reject) => { const socket = net.createServer(); socket.on('error', reject); socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)) }) })
  server = spawn(process.execPath, ['services/license-server/server.mjs'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, LICENSE_SERVER_PORT: String(port), LICENSE_SERVER_DATA_FILE: data, LICENSE_SERVER_PRIVATE_KEY_FILE: path.join(keys, 'publisher-private.pem'), LICENSE_SERVER_KEY_ID: 'publisher-v1' } })
  let startupError; server.on('error', error => { startupError = error })
  let ready = false
  for (let n = 0; n < 50; n++) {
    if (startupError || server.exitCode !== null) throw startupError ?? new Error('License server exited')
    try { if ((await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(500) })).ok) { ready = true; break } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!ready) throw new Error('License server did not become ready')
  const config = path.join(root, 'install.json')
  fs.writeFileSync(config, JSON.stringify({ outputDir: deployment, store: { code: 'release-smoke', name: 'Release smoke', baseUrl: 'https://release-smoke.test' }, admin: { email: 'admin@release-smoke.test', name: 'Admin' }, modules: ['commerce-core', 'commerce-b2b', 'content', 'invoices'], database: { urlEnv: 'AXIMA_DATABASE_URL' }, email: { enabled: false }, integration: { provider: 'one-c' }, license: { serverUrl: 'http://127.0.0.1:' + port, publisherPublicKeyFile: path.join(keys, 'publisher-public.pem'), activationKeyEnv: 'AXIMA_ACTIVATION_KEY', deploymentClass: 'production' } }))
  node(['scripts/install.mjs', 'apply', '--config', config], { ...process.env, AXIMA_ACTIVATION_KEY: activation, AXIMA_DATABASE_URL: 'postgresql://unused:unused@localhost/unused' })
  const check = (key, expected) => node(['scripts/license-check.mjs', path.join(deployment, 'config/license.json'), key, path.join(deployment, 'config/publisher-public.pem'), expected])
  const key = path.join(deployment, 'secrets/installation-private-key.pem'), wrong = path.join(root, 'wrong.pem')
  check(key, 'ACTIVE'); fs.writeFileSync(wrong, generateInstallationIdentity().privateKeyPem); check(wrong, 'INVALID'); check(key, 'ACTIVE')
  console.log('PASS: local license issuance, installation binding, copied-key rejection; no deployment acceptance claimed')
} finally {
  if (server && server.exitCode === null) { server.kill(); await new Promise(resolve => server.once('exit', resolve)) }
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('axima-license-smoke-')) throw new Error('Unsafe temporary cleanup path'); fs.rmSync(root, { recursive: true, force: true })
}
