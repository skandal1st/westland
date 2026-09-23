#!/usr/bin/env node
// Single image-based Compose deployment path. No git pull, build, or implicit migration on restart.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { acquireOperationLock } from './operation-lock.mjs'
import { immutableImage, persistImage, assertAdditiveMigration } from './deployment-lib.mjs'
import { inspectArchive, verifySnapshot } from './backup-restore.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const deployment = path.join(root, 'deployment'), envFile = path.join(deployment, 'secrets/.env')
const [action, ...argv] = process.argv.slice(2)
const opts = {}
for (let i = 0; i < argv.length; i++) {
  if (!['--image', '--config'].includes(argv[i]) || !argv[i + 1]) throw Error('Usage: install.sh --image ID [--config FILE] | update.sh --image ID | node scripts/deploy.mjs verify')
  opts[argv[i].slice(2)] = argv[++i]
}
if (!['install', 'update', 'verify'].includes(action)) throw Error('Expected install, update or verify')
if (action !== 'verify' && !immutableImage(opts.image)) throw Error('Provide --image sha256:... or registry/image@sha256:... (already loaded/pulled)')
const env = { ...process.env }
for (const match of fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8').matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)) delete env[match[1]]
for (const key of ['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'APP_IMAGE', 'DATABASE_URL', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'LICENSE_ENFORCE', 'NEXTAUTH_SECRET', 'NEXTAUTH_URL']) delete env[key]
const run = (bin, args, options = {}) => {
  try { return execFileSync(bin, args, { cwd: root, env, windowsHide: true, timeout: 300_000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options }).toString().trim() }
  catch (error) { if (fs.existsSync(deployment)) fs.writeFileSync(path.join(deployment, 'last-command-error.log'), [error.stdout, error.stderr].filter(Boolean).map(value => value.toString()).join('\n') || error.message, { mode: 0o600 }); throw Error(path.basename(bin) + ' command failed; inspect local containers and deployment/last-operation.json (secrets omitted)') }
}
const compose = (args, image, options = {}) => run('docker', ['compose', '--project-directory', root, '-f', path.join(root, 'docker-compose.yml'), '--env-file', envFile, ...args], { ...options, env: { ...env, ...(image ? { APP_IMAGE: image } : {}), ...options.env } })
const id = service => compose(['ps', '-aq', service])
const inspect = container => JSON.parse(run('docker', ['inspect', container]))[0]
const journal = { action, requestedImage: opts.image, status: 'RUNNING', startedAt: new Date().toISOString(), stages: [] }
const save = () => fs.writeFileSync(path.join(deployment, 'last-operation.json'), JSON.stringify(journal, null, 2), { mode: 0o600 })
const stage = name => { journal.stages.push(name); save(); console.log(name) }
const lock = acquireOperationLock(deployment, action)
let installStarted = false
let previous, writersStopped = false, migrationStarted = false, migrated = false, work
const resources = []
const hasEd = /^  ed:/m.test(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'))
const edEnabled = () => fs.existsSync(path.join(deployment, 'config/ed.json'))
const stop = () => { if (hasEd && id('ed')) compose(['--profile', 'ed', 'stop', '-t', '60', 'ed']); compose(['--profile', 'full', 'stop', '-t', '960', 'worker'], undefined, { timeout: 1_020_000 }); compose(['--profile', 'full', 'stop', '-t', '30', 'app']) }
function ready(expectedImage) {
  const app = id('app'), worker = id('worker')
  if (!app || !worker || inspect(app).State.Health?.Status !== 'healthy' || inspect(worker).State.Health?.Status !== 'healthy') throw Error('app/worker are not healthy')
  if (inspect(app).Image !== inspect(worker).Image || (expectedImage && inspect(app).Image !== expectedImage)) throw Error('Running app/worker do not match the selected immutable image')
  run('docker', ['exec', app, 'node', 'scripts/deployment-readiness.mjs'])
  if (edEnabled()) {
    const ed = id('ed')
    if (!ed || inspect(ed).Image !== inspect(app).Image || inspect(ed).State.Health?.Status !== 'healthy') throw Error('ED transport is not healthy on the selected image')
  }
}
function start(image) {
  compose(['--profile', 'full', 'up', '-d', '--no-build', '--pull', 'never', '--force-recreate', '--wait', '--wait-timeout', '150', 'app'], image)
  // Do not enable queue writers until the application passes business readiness.
  run('docker', ['exec', id('app'), 'node', 'scripts/deployment-readiness.mjs'])
  compose(['--profile', 'full', 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '150', 'worker'], image)
  if (edEnabled()) compose(['--profile', 'ed', 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '150', 'ed'], image)
  ready(image)
}
function validateCompose() {
  const cfg = JSON.parse(compose(['--profile', 'full', 'config', '--format', 'json']))
  const app = cfg.services.app, pg = cfg.services.postgres
  const db = new URL(app.environment.DATABASE_URL)
  if (db.hostname !== 'postgres' || (db.port && db.port !== '5432') || db.search || decodeURIComponent(db.username) !== pg.environment.POSTGRES_USER || decodeURIComponent(db.password) !== pg.environment.POSTGRES_PASSWORD || decodeURIComponent(db.pathname.slice(1)) !== pg.environment.POSTGRES_DB) throw Error('Only matching Compose-managed PostgreSQL is supported')
  if (app.environment.LICENSE_ENFORCE !== '1') throw Error('LICENSE_ENFORCE=1 required')
  return cfg
}
function installConfiguration() {
  if (process.platform !== 'win32' && process.getuid() !== 0) throw Error('Install as root to preserve runtime ownership')
  if (fs.existsSync(envFile)) return
  if (!opts.config) throw Error('Fresh installation requires --config install.config.json')
  const pendingFile = path.join(deployment, '.pending-install.json')
  if (!fs.existsSync(pendingFile) && (fs.existsSync(path.join(deployment, 'config/installation.json')) || fs.existsSync(path.join(deployment, 'secrets/installation-private-key.pem')))) throw Error('Incomplete existing deployment; recover configuration instead of replacing identity')
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) throw Error('ADMIN_PASSWORD must contain at least 12 characters')
  const config = JSON.parse(fs.readFileSync(path.resolve(opts.config), 'utf8'))
  config.outputDir = deployment
  if (new URL(config.store.baseUrl).protocol !== 'https:') throw Error('store.baseUrl must use HTTPS')
  const configHash = crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex')
  const pending = fs.existsSync(pendingFile) ? JSON.parse(fs.readFileSync(pendingFile, 'utf8')) : { configHash, password: crypto.randomBytes(24).toString('hex') }
  if (pending.configHash !== configHash) throw Error('Interrupted installation config differs; recover the original config')
  fs.writeFileSync(pendingFile, JSON.stringify(pending), { mode: 0o600 })
  const password = pending.password
  const database = 'postgresql://axima:' + password + '@postgres:5432/axima'
  config.database = { urlEnv: 'AXIMA_INSTALL_DATABASE' }
  const temporary = path.join(deployment, '.install-config.json')
  fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 })
  try { run(process.execPath, [path.join(root, 'scripts/install.mjs'), 'apply', '--config', temporary], { env: { ...env, AXIMA_INSTALL_DATABASE: database } }) }
  finally { fs.unlinkSync(temporary) }
  const lines = { POSTGRES_USER: 'axima', POSTGRES_PASSWORD: password, POSTGRES_DB: 'axima', DATABASE_URL: database,
    NEXTAUTH_URL: new URL(config.store.baseUrl).toString(), NEXTAUTH_SECRET: crypto.randomBytes(32).toString('hex'), LICENSE_ENFORCE: '1',
    STORE_PROFILE_PATH: '/app/deployment/config/store-profile.json', LICENSE_GRANT_PATH: '/app/deployment/config/license.json',
    LICENSE_INSTALLATION_KEY_PATH: '/app/deployment/secrets/installation-private-key.pem', LICENSE_PUBLISHER_PUBLIC_KEY_PATH: '/app/deployment/config/publisher-public.pem' }
  // Generated values are newline-free. Quote $ literally for Compose.
  fs.writeFileSync(envFile, Object.entries(lines).map(([key, value]) => key + "='" + String(value).replaceAll("'", "\\'") + "'").join('\n') + '\n', { mode: 0o600 })
  if (process.platform !== 'win32') {
    if (process.getuid() !== 0) throw Error('Install as root to assign deployment ownership to runtime UID 1001')
    function own(dir) { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); const stat = fs.lstatSync(file); if (stat.isSymbolicLink()) throw Error('Deployment symlink not supported'); if (stat.isDirectory()) own(file); fs.chownSync(file, 1001, 1001); fs.chmodSync(file, stat.isDirectory() ? 0o700 : 0o600) } }
    own(path.join(deployment, 'config')); own(path.join(deployment, 'secrets'))
    for (const name of ['config', 'secrets']) { fs.chownSync(path.join(deployment, name), 1001, 1001); fs.chmodSync(path.join(deployment, name), 0o700) }
  }
  fs.unlinkSync(pendingFile)
}
function rehearse(candidate, archive, cfg) {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-update-')); fs.chmodSync(work, 0o700)
  inspectArchive(archive)
  run('tar', ['-xzf', archive, '-C', work, '--no-same-owner', '--no-same-permissions'])
  verifySnapshot(work)
  const candidateContainer = 'axima-update-image-' + crypto.randomBytes(6).toString('hex')
  run('docker', ['create', '--name', candidateContainer, candidate]); resources.push(['container', candidateContainer])
  const migrations = path.join(work, 'candidate-migrations')
  run('docker', ['cp', candidateContainer + ':/app/prisma/migrations', migrations])
  const rows = JSON.parse(compose(['exec', '-T', 'postgres', 'psql', '-U', cfg.services.postgres.environment.POSTGRES_USER, '-d', cfg.services.postgres.environment.POSTGRES_DB, '-Atc',
    'SELECT coalesce(json_agg(t),\'[]\') FROM (SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations") t']))
  const applied = new Map(rows.filter(row => row.finished_at && !row.rolled_back_at).map(row => [row.migration_name, row.checksum]))
  if (rows.some(row => !row.finished_at && !row.rolled_back_at)) throw Error('Unfinished migration in source database')
  for (const [name, checksum] of applied) {
    const file = path.join(migrations, name, 'migration.sql')
    if (!fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== checksum) throw Error('Candidate rewrites or removes applied migration history')
  }
  for (const entry of fs.readdirSync(migrations, { withFileTypes: true })) {
    if (entry.isDirectory() && !applied.has(entry.name)) assertAdditiveMigration(fs.readFileSync(path.join(migrations, entry.name, 'migration.sql'), 'utf8'))
  }
  const suffix = crypto.randomBytes(6).toString('hex'), network = 'axima-update-copy-' + suffix, pg = network + '-pg'
  run('docker', ['network', 'create', '--internal', network]); resources.push(['network', network])
  const secret = crypto.randomBytes(24).toString('hex')
  run('docker', ['run', '-d', '--name', pg, '--network', network, '--network-alias', 'postgres',
    '-e', 'POSTGRES_USER=copy', '-e', 'POSTGRES_DB=copy', '-e', 'POSTGRES_PASSWORD=' + secret,
    '--health-cmd', 'pg_isready -h 127.0.0.1 -U copy -d copy', '--health-interval', '1s', '--health-retries', '60',
    inspect(id('postgres')).Image]); resources.push(['container', pg])
  run('docker', ['exec', pg, 'sh', '-c', 'for n in $(seq 1 60); do pg_isready -h 127.0.0.1 -U copy -d copy >/dev/null && exit 0; sleep 1; done; exit 1'])
  const dump = fs.openSync(path.join(work, 'database.dump'), 'r')
  try { run('docker', ['exec', '-i', pg, 'pg_restore', '-U', 'copy', '-d', 'copy', '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error'], { stdio: [dump, 'pipe', 'pipe'] }) }
  finally { fs.closeSync(dump) }
  const copyEnv = { ...cfg.services.app.environment, DATABASE_URL: 'postgresql://copy:' + secret + '@postgres:5432/copy' }
  // No host ports, production exchange volume, worker or external network in rehearsal.
  const base = ['run', '--rm', '--network', network, '--mount', 'type=bind,source=' + deployment + ',target=/app/deployment,readonly',
    ...Object.entries(copyEnv).flatMap(([key, value]) => ['-e', key + '=' + value])]
  run('docker', [...base, candidate, 'node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'])
  run('docker', [...base, candidate, 'node', 'scripts/deployment-readiness.mjs', '--database-copy'])
  run('docker', [...base, previous, 'node', 'scripts/deployment-readiness.mjs', '--database-copy'])
  stage('PASS: candidate migrations and previous-image schema/business reads on isolated database copy')
}
try {
  if (action === 'verify') { const cfg = validateCompose(); if (!immutableImage(cfg.services.app.image)) throw Error('Configured image is not immutable'); ready(JSON.parse(run('docker', ['image', 'inspect', cfg.services.app.image]))[0].Id); stage('PASS: app, worker and business prerequisites'); journal.status = 'PASS' }
  else {
    const image = JSON.parse(run('docker', ['image', 'inspect', opts.image]))[0].Id
    if (!immutableImage(image)) throw Error('Cannot resolve immutable image')
    journal.image = image
    if (action === 'install') {
      stage('Prepare installation configuration')
      installConfiguration()
      const installedConfig = validateCompose()
      if (immutableImage(installedConfig.services.app.image) && JSON.parse(run('docker', ['image', 'inspect', installedConfig.services.app.image]))[0].Id !== image) throw Error('Installation is pinned to another image; recover that image, then use update.sh')
      const existing = id('app')
      if (existing) {
        if (inspect(existing).Image !== image) throw Error('Installation already exists with a different image; use update.sh')
        // A repeat install must not reset settings or administrator credentials.
        persistImage(envFile, image); installStarted = true; start(image)
      } else {
        persistImage(envFile, image)
        if (!env.ADMIN_PASSWORD) throw Error('ADMIN_PASSWORD required for initial bootstrap')
        installStarted = true
        compose(['up', '-d', '--wait', '--wait-timeout', '60', 'postgres'], image)
        stage('Migrate and bootstrap fixed image')
        compose(['run', '--rm', '--no-deps', '-e', 'ADMIN_PASSWORD', 'app', 'node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'], image)
        compose(['run', '--rm', '--no-deps', '-e', 'ADMIN_PASSWORD', 'app', 'node', 'scripts/bootstrap.mjs', '--create-only'], image)
        start(image)
      }
    } else {
      const cfg = validateCompose()
      ready()
      previous = inspect(id('app')).Image
      if (inspect(id('worker')).Image !== previous) throw Error('App and worker images differ')
      journal.previousImage = previous
      persistImage(envFile, previous)
      stage('Stop writers and capture mandatory recovery snapshot')
      writersStopped = true; stop()
      const backups = path.join(deployment, 'update-backups', crypto.randomUUID())
      run(process.execPath, [path.join(root, 'scripts/backup-restore.mjs'), 'backup', '--out', backups], { env: { ...env, AXIMA_DEPLOY_LOCK_TOKEN: lock.token } })
      const archives = fs.readdirSync(backups).filter(name => name.endsWith('.tar.gz'))
      if (archives.length !== 1) throw Error('Expected exactly one completed backup')
      journal.backup = path.join(backups, archives[0]); save()
      stage('Rehearse migrations and rollback compatibility on database copy')
      rehearse(image, journal.backup, cfg)
      stage('Apply rehearsed migrations to installation')
      migrationStarted = true
      compose(['run', '--rm', '--no-deps', 'app', 'node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'], image)
      migrated = true
      stage('Start candidate and verify business readiness')
      start(image)
      persistImage(envFile, image)
      writersStopped = false
    }
    journal.status = 'PASS'; stage('PASS: immutable app/worker image and deployment readiness')
  }
} catch (error) {
  journal.error = error.message; journal.status = 'FAIL'
  if (previous && writersStopped && (!migrationStarted || migrated)) {
    try { stage('Candidate rejected; restore previous immutable application image'); stop(); persistImage(envFile, previous); start(previous); journal.status = 'ROLLED_BACK'; stage('PASS: previous app and worker ready; image pin restored') }
    catch { journal.status = 'RECOVERY_REQUIRED'; try { stop() } catch {} }
  } else if (migrationStarted && !migrated) {
    journal.status = 'RECOVERY_REQUIRED'; try { stop() } catch {}
  } else if (action === 'install' && installStarted) { try { if (fs.existsSync(envFile)) stop() } catch {} }
  console.error('Deployment failed: ' + error.message + '. Status: ' + journal.status)
  process.exitCode = 1
} finally {
  let cleanupFailed = false
  for (const [type, name] of resources.reverse()) {
    try { run('docker', type === 'network' ? ['network', 'rm', name] : ['rm', '-f', '-v', name]) }
    catch { cleanupFailed = true; console.error('Could not remove rehearsal resource ' + name) }
  }
  if (work && journal.status === 'PASS' && !cleanupFailed) {
    if (path.dirname(path.resolve(work)) !== path.resolve(os.tmpdir()) || !path.basename(work).startsWith('axima-update-')) throw Error('Unsafe rehearsal cleanup')
    fs.rmSync(work, { recursive: true, force: true })
  }
  if (cleanupFailed) { journal.cleanupFailed = true; process.exitCode = 1 }
  journal.finishedAt = new Date().toISOString(); save(); lock.release()
}
