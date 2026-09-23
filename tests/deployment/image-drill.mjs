// Invoked inside the Linux driver by scripts/deployment-drill.mjs.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
const repo = process.env.AXIMA_DRILL_SOURCE || process.cwd()
const image = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', process.argv[2]], { encoding: 'utf8' }).trim()
if (!/^sha256:[a-f0-9]{64}$/.test(image || '')) throw Error('Exact image ID required')
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-r37-'))
const evidence = { image, platform: process.platform, stages: [], status: 'RUNNING' }
const save = () => fs.writeFileSync(path.join(base, 'result.json'), JSON.stringify(evidence, null, 2))
const run = (bin, args, options = {}) => execFileSync(bin, args, { cwd: repo, timeout: 900_000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options }).toString().trim()
const migrationCount = Number(run('docker', ['run', '--rm', '--network', 'none', image, 'node', '-e', "const f=require('fs');console.log(f.readdirSync('/app/prisma/migrations',{withFileTypes:true}).filter(x=>x.isDirectory()).length)"]))
assert.ok(migrationCount > 0)
const projects = [], variants = []
const baseTag = 'axima-release-cache:' + image.slice(7, 23)
run('docker', ['tag', image, baseTag])
let issuer
const env = { ...process.env, ADMIN_PASSWORD: 'R37-test-only-administrator-42!' }
delete env.COMPOSE_FILE; delete env.COMPOSE_PROJECT_NAME; delete env.AXIMA_DEPLOY_LOCK_TOKEN
async function step(name, fn) {
  console.log('RUN ' + name)
  try { await fn(); evidence.stages.push({ name, status: 'PASS' }); save(); console.log('PASS ' + name) }
  catch (e) { evidence.stages.push({ name, status: 'FAIL' }); throw e }
}
function fixture(name) {
  const root = path.join(base, name); fs.mkdirSync(root)
  for (const file of ['scripts/deploy.mjs', 'scripts/deployment-lib.mjs', 'scripts/operation-lock.mjs', 'scripts/backup-restore.mjs', 'scripts/install.mjs', 'packages/license-core/index.mjs', 'install.sh', 'update.sh', 'backup.sh', 'restore.sh']) {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(repo, file), target)
  }
  fs.writeFileSync(path.join(root, 'docker-compose.yml'), 'name: axima-r37-' + path.basename(base).slice(-6).toLowerCase() + '-' + name + '\n' + fs.readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8').replace('$' + '{POSTGRES_PORT:-5432}', '0').replace('$' + '{APP_PORT:-3000}', '0').replace('$' + '{ED_PORT:-3318}', '0'))
  const ctx = { root }
  ctx.compose = args => run('docker', ['compose', '--project-directory', root, '-f', path.join(root, 'docker-compose.yml'), '--env-file', path.join(root, 'deployment/secrets/.env'), ...args], { env })
  ctx.id = service => ctx.compose(['ps', '-aq', service])
  ctx.sql = sql => ctx.compose(['exec', '-T', 'postgres', 'psql', '-U', 'axima', '-d', 'axima', '-v', 'ON_ERROR_STOP=1', '-Atc', sql])
  ctx.cli = (action, args = [], expected = 0) => {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/deploy.mjs'), action, ...args], { env, cwd: '/', encoding: 'utf8', timeout: 900_000 })
    fs.appendFileSync(path.join(base, 'operations.log'), action + '\n' + result.stdout + result.stderr + '\n')
    assert.equal(result.status, expected, result.stdout + result.stderr)
    return JSON.parse(fs.readFileSync(path.join(root, 'deployment/last-operation.json')))
  }
  ctx.recovery = args => {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/backup-restore.mjs'), ...args], { env, cwd: '/', encoding: 'utf8', timeout: 300_000 })
    fs.appendFileSync(path.join(base, 'operations.log'), 'recovery\n' + result.stdout + result.stderr + '\n')
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  ctx.image = () => run('docker', ['inspect', '--format', '{{.Image}}', ctx.id('app')])
  ctx.exec = code => run('docker', ['exec', ctx.id('app'), 'node', '-e', code])
  ctx.hash = relative => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'deployment', relative))).digest('hex')
  projects.push(ctx); return ctx
}
function variant(name, sql, broken = false) {
  const dir = path.join(base, name); fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'migration.sql'), sql)
  let dockerfile = 'FROM ' + baseTag + '\nCOPY migration.sql /app/prisma/migrations/20990101000000_r37_probe/migration.sql\n'
  if (broken) {
    fs.writeFileSync(path.join(dir, 'readiness.mjs'), "if (!process.argv.includes('--database-copy')) { console.error('R37 injected business readiness failure'); process.exit(1) }\n" + fs.readFileSync(path.join(repo, 'scripts/deployment-readiness.mjs'), 'utf8'))
    dockerfile += 'COPY readiness.mjs /app/scripts/deployment-readiness.mjs\n'
  }
  fs.writeFileSync(path.join(dir, 'Dockerfile'), dockerfile)
  run('docker', ['build', '--iidfile', path.join(dir, 'iid'), dir])
  const id = run('docker', ['image', 'inspect', '--format', '{{.Id}}', fs.readFileSync(path.join(dir, 'iid'), 'utf8').trim()]); variants.push(id); return id
}
try {
  const source = fixture('source'), fresh = fixture('fresh')
  const keyDir = path.join(base, 'publisher'), data = path.join(base, 'licenses.json')
  run(process.execPath, ['services/license-server/keygen.mjs', keyDir])
  const activation = run(process.execPath, ['services/license-server/issue.mjs', '--data', data, '--customer', 'r37-drill', '--modules', 'commerce-core,commerce-b2b,content,invoices']).split(/\r?\n/).at(-1)
  issuer = spawn(process.execPath, [path.join(repo, 'services/license-server/server.mjs')], { stdio: 'ignore', env: { ...env, LICENSE_SERVER_PORT: '44010', LICENSE_SERVER_DATA_FILE: data, LICENSE_SERVER_PRIVATE_KEY_FILE: path.join(keyDir, 'publisher-private.pem'), LICENSE_SERVER_KEY_ID: 'publisher-v1' } })
  let started = false
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch('http://127.0.0.1:44010/health')).ok) { started = true; break } } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  assert.ok(started, 'local test issuer starts')
  const config = path.join(base, 'install.json')
  fs.writeFileSync(config, JSON.stringify({ store: { code: 'r37-drill', name: 'R37 drill', baseUrl: 'https://r37.test' }, admin: { email: 'admin@r37.test', name: 'Admin' }, modules: ['commerce-core', 'commerce-b2b', 'content', 'invoices'], database: { urlEnv: 'IGNORED' }, email: { enabled: false }, integration: { provider: 'custom' }, license: { serverUrl: 'http://127.0.0.1:44010', publisherPublicKeyFile: path.join(keyDir, 'publisher-public.pem'), activationKeyEnv: 'AXIMA_ACTIVATION_KEY', deploymentClass: 'production' } }))
  await step('failed activation can be retried without replacing pending installation', () => {
    source.cli('install', ['--image', image, '--config', config], 1)
    assert.ok(fs.existsSync(path.join(source.root, 'deployment/.pending-install.json')))
  })
  env.AXIMA_ACTIVATION_KEY = activation
  await step('fresh install: activation, migrations, bootstrap, app and worker readiness', () => {
    assert.equal(source.cli('install', ['--image', image, '--config', config]).status, 'PASS')
    assert.equal(source.image(), image)
    assert.equal(source.sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'), String(migrationCount))
  })
  delete env.AXIMA_ACTIVATION_KEY; issuer.kill(); await new Promise(r => issuer.once('exit', r)); issuer = null
  const preserved = ['config/installation.json', 'config/license.json', 'config/store-profile.json', 'secrets/installation-private-key.pem']
  const hashes = preserved.map(file => source.hash(file))
  const environmentState = ctx => fs.readFileSync(path.join(ctx.root, 'deployment/secrets/.env'), 'utf8').replace(/^APP_IMAGE=.*\r?\n/gm, '')
  const originalEnvironment = environmentState(source)
  const admin = source.sql('SELECT "passwordHash" FROM "User" WHERE role=\'ADMIN\'')
  await step('repeat install without issuer preserves identity, credentials and settings', () => {
    source.sql('UPDATE "AppSettings" SET "invoicePrefix"=\'KEEP\'')
    assert.equal(source.cli('install', ['--image', image]).status, 'PASS')
    assert.deepEqual(preserved.map(file => source.hash(file)), hashes)
    assert.equal(source.sql('SELECT "invoicePrefix" FROM "AppSettings"'), 'KEEP')
    assert.equal(source.sql('SELECT "passwordHash" FROM "User" WHERE role=\'ADMIN\''), admin)
    assert.equal(source.sql('SELECT count(*) FROM "User" WHERE role=\'ADMIN\''), '1')
  })

  let edIdentity
  await step('ED service uses fixed image and persistent backed-up state', () => {
    const file = path.join(source.root, 'deployment/config/ed.json')
    fs.writeFileSync(file, JSON.stringify({ username: 'drill', password: 'ed-drill-only-012345678901234567890123456789', basePath: '/api/integrations/1c/ed-pilot', port: 3318, setupEnabled: true, filesEnabled: true }), { mode: 0o600 })
    fs.chownSync(file, 1001, 1001)
    source.compose(['--profile', 'ed', 'up', '-d', '--no-build', '--wait', '--wait-timeout', '150', 'ed'])
    source.cli('verify')
    edIdentity = source.exec("console.log(require('fs').readFileSync('/app/exchange/ed/onboarding/identity.json','utf8'))")
    source.exec("require('fs').writeFileSync('/app/exchange/ed/state-preserved.txt','ED-before')")
    source.compose(['--profile', 'ed', 'restart', 'ed'])
    source.compose(['--profile', 'ed', 'up', '-d', '--no-build', '--wait', '--wait-timeout', '150', 'ed'])
    assert.equal(source.exec("console.log(require('fs').readFileSync('/app/exchange/ed/onboarding/identity.json','utf8'))"), edIdentity)
  })

  source.exec("require('fs').writeFileSync('/app/exchange/r37.xml','exchange-before');require('fs').writeFileSync('/app/.media/r37-probe','cache-before')")
  fs.mkdirSync(path.join(source.root, 'public/uploads'), { recursive: true }); fs.writeFileSync(path.join(source.root, 'public/uploads/r37.txt'), 'uploads-before')
  const safe = variant('safe', 'ALTER TABLE "Store" ADD COLUMN "r37Optional" TEXT;')
  const bad = variant('business-failure', 'ALTER TABLE "Store" ADD COLUMN "r37Optional" TEXT;', true)
  const destructive = variant('destructive', 'DROP TABLE "User";')
  const duplicate = variant('copy-failure', 'ALTER TABLE "Store" ADD COLUMN "slug" TEXT;')
  await step('install with a different image is rejected without stopping existing services', () => {
    assert.equal(source.cli('install', ['--image', safe], 1).status, 'FAIL')
    assert.equal(source.image(), image)
    source.cli('verify')
    source.compose(['--profile', 'full', 'rm', '-f', '-s', 'worker', 'app'])
    assert.equal(source.cli('install', ['--image', safe], 1).status, 'FAIL')
    assert.equal(source.id('app'), '')
    assert.equal(source.cli('install', ['--image', image]).status, 'PASS')
    assert.equal(source.sql('SELECT "invoicePrefix" FROM "AppSettings"'), 'KEEP')
    assert.equal(source.sql('SELECT "passwordHash" FROM "User" WHERE role=\'ADMIN\''), admin)
  })
  await step('destructive migration rejected before source changes; previous image resumes', () => {
    const result = source.cli('update', ['--image', destructive], 1)
    assert.equal(result.status, 'ROLLED_BACK')
    assert.match(result.error, /additive/)
    assert.equal(source.sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'), String(migrationCount))
    assert.equal(source.image(), image)
  })
  await step('migration failure on copied database leaves source unchanged', () => {
    assert.equal(source.cli('update', ['--image', duplicate], 1).status, 'ROLLED_BACK')
    assert.match(fs.readFileSync(path.join(source.root, 'deployment/last-command-error.log'), 'utf8'), /P3018|already exists/)
    assert.equal(source.sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'), String(migrationCount))
  })
  await step('HTTP-healthy candidate fails business readiness; old image works with forward migration', () => {
    const result = source.cli('update', ['--image', bad], 1)
    assert.equal(result.status, 'ROLLED_BACK')
    assert.ok(result.stages.includes('Start candidate and verify business readiness'))
    assert.equal(source.sql('SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'), String(migrationCount + 1))
    assert.equal(source.image(), image)
    assert.match(fs.readFileSync(path.join(source.root, 'deployment/secrets/.env'), 'utf8'), new RegExp('APP_IMAGE=' + image))
    source.cli('verify')
  })
  await step('successful fixed-image update and restart preserve identity and data', () => {
    assert.equal(source.cli('update', ['--image', safe]).status, 'PASS')
    assert.equal(source.image(), safe)
    assert.equal(environmentState(source), originalEnvironment)
    assert.equal(source.exec("console.log(require('fs').readFileSync('/app/.media/r37-probe','utf8'))"), 'cache-before')
    assert.deepEqual(preserved.map(file => source.hash(file)), hashes)
    assert.equal(source.sql('SELECT "passwordHash" FROM "User" WHERE role=\'ADMIN\''), admin)
    source.compose(['--profile', 'full', 'restart', 'app', 'worker'])
    source.compose(['--profile', 'full', 'up', '-d', '--no-build', '--wait', '--wait-timeout', '150', 'app', 'worker'])
    source.cli('verify')
    assert.equal(source.image(), safe)
  })
  const backups = path.join(base, 'backups')
  source.recovery(['backup', '--out', backups])
  const archive = path.join(backups, fs.readdirSync(backups).find(n => n.endsWith('.tar.gz')))
  await step('fresh restore preserves license, DB, files and Linux ownership', () => {
    fresh.recovery(['restore', '--archive', archive, '--confirm'])
    assert.equal(run('docker', ['inspect', '--format', '{{.State.Running}}', fresh.id('app')]), 'false')
    fresh.compose(['--profile', 'full', '--profile', 'ed', 'up', '-d', '--no-build', '--wait', '--wait-timeout', '150', 'app', 'worker', 'ed'])
    assert.equal(fresh.exec("console.log(require('fs').readFileSync('/app/exchange/ed/onboarding/identity.json','utf8'))"), edIdentity)
    assert.equal(fresh.exec("console.log(require('fs').readFileSync('/app/exchange/ed/state-preserved.txt','utf8'))"), 'ED-before')
    fresh.cli('verify')
    assert.equal(fresh.image(), safe)
    assert.equal(environmentState(fresh), originalEnvironment)
    assert.deepEqual(preserved.map(file => fresh.hash(file)), hashes)
    assert.equal(fresh.sql('SELECT "passwordHash" FROM "User" WHERE role=\'ADMIN\''), admin)
    assert.equal(fresh.exec("console.log(require('fs').readFileSync('/app/exchange/r37.xml','utf8'))"), 'exchange-before')
    assert.equal(fs.readFileSync(path.join(fresh.root, 'public/uploads/r37.txt'), 'utf8'), 'uploads-before')
    const st = fs.statSync(path.join(fresh.root, 'deployment/secrets/installation-private-key.pem'))
    assert.equal(st.uid, 1001); assert.equal(st.mode & 0o777, 0o600)
  })
  await step('invalid license remains HTTP-live but fails deployment readiness', () => {
    const file = path.join(fresh.root, 'deployment/config/license.json'), original = fs.readFileSync(file)
    fs.writeFileSync(file, '{}')
    fresh.compose(['--profile', 'full', 'restart', 'app'])
    fresh.compose(['--profile', 'full', 'up', '-d', '--no-build', '--wait', '--wait-timeout', '150', 'app'])
    assert.equal(fresh.exec("fetch('http://127.0.0.1:3000/api/health').then(async r=>console.log(r.status))"), '200')
    fresh.cli('verify', [], 1)
    fs.writeFileSync(file, original)
  })
  evidence.status = 'PASS'
} catch (error) { evidence.status = 'FAIL'; console.error(error.message); process.exitCode = 1 }
finally {
  if (issuer) issuer.kill()
  for (const ctx of projects.reverse()) {
    if (fs.existsSync(path.join(ctx.root, 'deployment/secrets/.env'))) {
      try { ctx.compose(['--profile', 'full', '--profile', 'ed', 'down', '--volumes', '--remove-orphans']) }
      catch { evidence.cleanupFailed = true; process.exitCode = 1 }
    }
  }
  for (const id of [...new Set(variants)]) { try { run('docker', ['image', 'rm', id]) } catch { evidence.cleanupFailed = true; process.exitCode = 1 } }
  save(); console.log('R37_RESULT ' + JSON.stringify(evidence)); console.log('R37_EVIDENCE ' + base)
}
