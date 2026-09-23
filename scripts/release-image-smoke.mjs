#!/usr/bin/env node
// Fresh isolated database, actual migrations and HTTP from the immutable image.
// No customer deployment, ERP connection, backup/restore or rollback acceptance.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
const image = process.argv[2]
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('Expected immutable sha256 image ID')
const prefix = 'axima-release-' + randomUUID(), pg = prefix + '-pg', app = prefix + '-app'
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
let networkCreated = false, pgCreated = false, appCreated = false
try {
  docker(['network', 'create', '--internal', prefix]); networkCreated = true
  docker(['run', '-d', '--name', pg, '--network', prefix, '--network-alias', 'postgres', '-e', 'POSTGRES_USER=release_test', '-e', 'POSTGRES_PASSWORD=disposable_local_test', '-e', 'POSTGRES_DB=release_test', 'postgres:16-alpine']); pgCreated = true
  let ready = false
  for (let n = 0; n < 60; n++) { try { docker(['exec', pg, 'pg_isready', '-U', 'release_test', '-d', 'release_test']); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 500)) } }
  if (!ready) throw new Error('Fresh test PostgreSQL did not become ready')
  const db = 'DATABASE_URL=postgresql://release_test:disposable_local_test@postgres:5432/release_test'
  docker(['run', '--rm', '--network', prefix, '-e', db, image, 'node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'])
  docker(['run', '--rm', '--network', 'none', image, 'sh', '-ec', 'test -f server.js; test -f dist/integration-worker.cjs; node --check dist/integration-worker.cjs; node --check dist/enterprisedata-http-probe.cjs'])
  docker(['run', '-d', '--name', app, '--network', prefix, '-e', db, '-e', 'LICENSE_ENFORCE=0', '-e', 'NEXTAUTH_SECRET=isolated-release-smoke-only', '-e', 'NEXTAUTH_URL=http://localhost:3000', image]); appCreated = true
  let healthy = false
  for (let n = 0; n < 60; n++) {
    try { docker(['exec', app, 'node', '-e', "fetch('http://127.0.0.1:3000/api/health').then(async r=>{const h=await r.json();if(!r.ok||h.db!=='ok'||h.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"]); healthy = true; break }
    catch { await new Promise(resolve => setTimeout(resolve, 500)) }
  }
  if (!healthy) throw new Error('Image HTTP/database smoke failed')
  docker(['exec', app, 'node', '-e', "fetch('http://127.0.0.1:3000/login').then(async r=>{if(!r.ok||!(await r.text()).includes('<html'))process.exit(1)}).catch(()=>process.exit(1))"])
  console.log('PASS immutable image: migrations on fresh DB, HTTP/DB health, login HTML, bundled worker syntax')
} finally {
  // Unique names created only by this invocation; never operate on deployment/acceptance containers.
  const errors = []
  for (const [created, args] of [[appCreated, ['rm', '-fv', app]], [pgCreated, ['rm', '-fv', pg]], [networkCreated, ['network', 'rm', prefix]]]) {
    if (created) try { docker(args) } catch { errors.push(args.join(' ')) }
  }
  if (errors.length) throw new Error('Test cleanup failed: ' + errors.join('; '))
}
