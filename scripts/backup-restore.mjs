#!/usr/bin/env node
// Concrete backup/restore CLI for the Compose-managed AXIMA installation.
// No application mutations are performed by backup. Restore deliberately leaves app stopped.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { acquireOperationLock } from './operation-lock.mjs';
import { verifyGrantEnvelope } from '../packages/license-core/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = [
  'database.dump', 'deployment/config/store-profile.json', 'deployment/config/installation.json',
  'deployment/config/license.json', 'deployment/config/publisher-public.pem',
  'deployment/secrets/.env', 'deployment/secrets/installation-private-key.pem',
];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const fail = message => { throw new Error(message); };
function run(bin, args, options = {}) {
  try { return execFileSync(bin, args, { timeout: 120_000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options }); }
  catch { fail(`${path.basename(bin)} command failed or timed out; application remains stopped during an incomplete restore. Inspect the local service logs (credentials are not printed).`); }
}
function tree(dir, prefix = '') {
  const result = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fail(`Symlink is not supported in recovery data: ${name}`);
    if (entry.isDirectory()) Object.assign(result, tree(full, name));
    else if (entry.isFile()) result[name] = hash(fs.readFileSync(full));
    else fail(`Special file is not supported in recovery data: ${name}`);
  }
  return result;
}
function allowed(name) {
  return name === 'manifest.json' || name === 'database.dump' || name === 'exchange' || name === 'uploads'
    || name === 'deployment' || name === 'deployment/config' || name === 'deployment/secrets'
    || ['deployment/config/', 'deployment/secrets/', 'exchange/', 'uploads/'].some(p => name.startsWith(p));
}
export function inspectArchive(archive) {
  const names = run('tar', ['-tzf', archive]).toString('utf8').trimEnd().split(/\r?\n/);
  const verbose = run('tar', ['-tvzf', archive]).toString('utf8').trimEnd().split(/\r?\n/);
  for (const line of verbose) if (!['-', 'd'].includes(line[0])) fail('Archive contains a link or special entry');
  const seen = new Set();
  for (let name of names) {
    name = name.replace(/^(\.\/)+/, '').replace(/\/$/, '');
    if (name === '.' || !name) continue;
    if (/[\\\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || /^[a-z]:/i.test(name)
      || name.split('/').some(p => p === '..') || !allowed(name) || seen.has(name)) fail('Archive has an unsafe, duplicate, or unsupported path');
    seen.add(name);
  }
  if (!seen.has('manifest.json')) fail('Archive has no v1 recovery manifest; legacy archives require a separate reviewed migration');
}
export function capturePermissions(base, names) {
  const result = {};
  function visit(name) {
    const full = path.join(base, name), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) fail('Deployment permissions cannot include symlinks');
    result[name] = { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
    if (stat.isDirectory()) for (const child of fs.readdirSync(full)) visit(`${name}/${child}`);
  }
  for (const name of names) visit(name);
  return result;
}
function validatePermissions(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('Deployment permissions missing from backup');
  for (const [name, value] of Object.entries(metadata)) {
    if (!['deployment/config', 'deployment/secrets'].some(p => name === p || name.startsWith(p + '/'))
      || name.split('/').includes('..') || name.includes(String.fromCharCode(92)) || !value
      || ![value.uid, value.gid, value.mode].every(n => Number.isSafeInteger(n) && n >= 0)
      || value.mode > 0o777 || value.uid >= 0xffffffff || value.gid >= 0xffffffff) fail('Invalid deployment permission metadata');
  }
}
export function restorePermissions(base, metadata) {
  validatePermissions(metadata);
  for (const [name, value] of Object.entries(metadata)) {
    const full = path.join(base, name);
    if (fs.lstatSync(full).isSymbolicLink()) fail('Unexpected permission target symlink');
    if (process.platform !== 'win32') fs.chownSync(full, value.uid, value.gid);
    fs.chmodSync(full, value.mode);
  }
}
function licenseStatus(dir) {
  try {
    const envelope = JSON.parse(fs.readFileSync(path.join(dir, 'deployment/config/license.json'), 'utf8'));
    verifyGrantEnvelope(envelope, { [envelope.keyId]: fs.readFileSync(path.join(dir, 'deployment/config/publisher-public.pem'), 'utf8') },
      fs.readFileSync(path.join(dir, 'deployment/secrets/installation-private-key.pem'), 'utf8'));
    return 'ACTIVE';
  } catch { return 'INVALID'; }
}
export function verifySnapshot(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.database?.source !== 'compose:postgres' || !manifest.files
    || !['ACTIVE', 'INVALID'].includes(manifest.licenseStatus)) fail('Unsupported recovery manifest');
  const actual = tree(dir); delete actual['manifest.json'];
  for (const name of REQUIRED) if (!actual[name]) fail(`Required backup file missing: ${name}`);
  if (!fs.statSync(path.join(dir, 'exchange')).isDirectory()) fail('Required exchange snapshot missing');
  const expected = manifest.files;
  validatePermissions(manifest.deploymentPermissions);
  const permissionPaths = Object.keys(capturePermissions(dir, ['deployment/config', 'deployment/secrets']));
  if (permissionPaths.length !== Object.keys(manifest.deploymentPermissions).length
    || permissionPaths.some(name => !manifest.deploymentPermissions[name])) fail('Incomplete deployment permission metadata');
  if (Object.keys(actual).length !== Object.keys(expected).length) fail('Backup file set does not match manifest');
  for (const [name, digest] of Object.entries(actual)) {
    if (!allowed(name) || digest !== expected[name]) fail(`Backup checksum mismatch: ${name}`);
  }
  if (manifest.licenseStatus !== licenseStatus(dir)) fail('Restored license does not match recorded state');
  if (!manifest.exchangeOwner || !Number.isSafeInteger(manifest.exchangeOwner.uid) || manifest.exchangeOwner.uid < 0
    || !Number.isSafeInteger(manifest.exchangeOwner.gid) || manifest.exchangeOwner.gid < 0) fail('Invalid exchange ownership');
  return manifest;
}
function envOf(info) { return Object.fromEntries((info.Config.Env ?? []).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; })); }
function checkManagedDatabase(app, pg) {
  const a = envOf(app), p = envOf(pg);
  let u; try { u = new URL(a.DATABASE_URL); } catch { fail('Application DATABASE_URL is invalid'); }
  if (u.hostname !== 'postgres' || (u.port && u.port !== '5432') || decodeURIComponent(u.pathname.slice(1)) !== p.POSTGRES_DB
    || decodeURIComponent(u.username) !== p.POSTGRES_USER || decodeURIComponent(u.password) !== p.POSTGRES_PASSWORD) {
    fail('Recovery supports only the matching Compose-managed postgres database; refusing a mismatched/external database');
  }
  if (!app.Mounts.some(m => m.Destination === '/app/exchange')) fail('App has no /app/exchange mount');
  for (const [key, expected] of Object.entries({ STORE_PROFILE_PATH: '/app/deployment/config/store-profile.json',
    LICENSE_GRANT_PATH: '/app/deployment/config/license.json', LICENSE_INSTALLATION_KEY_PATH: '/app/deployment/secrets/installation-private-key.pem',
    LICENSE_PUBLISHER_PUBLIC_KEY_PATH: '/app/deployment/config/publisher-public.pem' })) {
    if (a[key] && a[key] !== expected) fail(`Unsupported recovery path for ${key}`);
  }
  return { source: 'compose:postgres', name: p.POSTGRES_DB, user: p.POSTGRES_USER };
}
function safeTarget(relative) {
  const full = path.resolve(ROOT, relative);
  if (!full.startsWith(ROOT + path.sep)) fail('Target escapes installation');
  let p = full;
  while (p !== ROOT) { if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fail('Recovery target contains a symlink'); p = path.dirname(p); }
  return full;
}
function replaceDirectory(source, relative, previous) {
  const dest = safeTarget(relative), stage = `${dest}.restore-${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(source, stage, { recursive: true, errorOnExist: true, force: false });
  // A sibling rename avoids nested config/config and preserves old files on failure.
  if (fs.existsSync(dest)) {
    const old = `${dest}.before-restore-${crypto.randomUUID()}`;
    fs.renameSync(dest, old); previous.push(old);
    try { fs.renameSync(stage, dest); } catch (e) { fs.renameSync(old, dest); throw e; }
  } else fs.renameSync(stage, dest);
}
async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!['backup', 'restore'].includes(action)) fail('Specify backup or restore');
  if (args.includes('--help') || args.includes('-h')) {
    console.log('backup.sh [--out DIR]\nrestore.sh --archive FILE --confirm\nRequires Node.js, tar, Docker Compose. Restore leaves app stopped.'); return;
  }
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--confirm') opts.confirm = true;
    else if ((action === 'backup' && key === '--out') || (action === 'restore' && key === '--archive')) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) fail(`Missing value for ${key}`);
      opts[key.slice(2)] = path.resolve(args[++i]);
    } else fail(`Unknown option: ${key}`);
  }
  if (action === 'restore' && (!opts.archive || !opts.confirm)) fail('Restore requires --archive FILE --confirm');
  const deployment = safeTarget('deployment'); fs.mkdirSync(deployment, { recursive: true });
  const operationLock = acquireOperationLock(deployment, action);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-recovery-')); fs.chmodSync(work, 0o700);
  let envFile = path.join(deployment, 'secrets/.env');
  let resumeBackupEd = false, resumeBackupApp = false, resumeBackupWorker = false, appId, failed = true;
  const compose = (args, options) => run('docker', ['compose', '--project-directory', ROOT, '-f', path.join(ROOT, 'docker-compose.yml'), '--env-file', envFile, ...args], options);
  const inspect = id => JSON.parse(run('docker', ['inspect', id]).toString())[0];
  const serviceId = name => compose(['ps', '-aq', name]).toString().trim();
  const workerId = () => compose(['--profile', 'full', 'config', '--services']).toString().split(/\s+/).includes('worker') ? serviceId('worker') : '';
  const edId = () => compose(['--profile', 'ed', 'config', '--services']).toString().split(/\s+/).includes('ed') ? serviceId('ed') : '';
  const stopEd = () => { if (edId()) compose(['--profile', 'ed', 'stop', '-t', '60', 'ed']); };
  const stopWorker = () => { if (workerId()) compose(['stop', '-t', '30', 'worker']); };
  const stoppedVolumeCommand = (info, code) => run('docker', ['run', '--rm', '--network', 'none', '--user', '0', '--volumes-from', appId, '--entrypoint', 'node', info.Image, '-e', code]);
  try {
    if (action === 'backup') {
      if (!fs.existsSync(envFile)) fail('No deployment/secrets/.env; refusing incomplete backup');
      appId = serviceId('app'); const pgId = serviceId('postgres');
      if (!appId || !pgId) fail('App and PostgreSQL containers must exist before backup');
      const app = inspect(appId), pg = inspect(pgId);
      const database = checkManagedDatabase(app, pg);
      for (const name of REQUIRED.filter(n => n.startsWith('deployment/'))) {
        if (!fs.existsSync(safeTarget(name))) fail(`Required backup file missing: ${name}`);
      }
      const appMount = app.Mounts.find(m => m.Destination === '/app/deployment');
      if (!appMount || appMount.Type !== 'bind') fail('Expected bind-mounted deployment directory');
      const hostPath = value => {
        let normalized = value.split(String.fromCharCode(92)).join('/');
        for (const prefix of ['/run/desktop/mnt/host/', '/host_mnt/']) {
          if (normalized.startsWith(prefix)) {
            const tail = normalized.slice(prefix.length);
            if (tail[1] === '/') normalized = tail[0] + ':' + tail.slice(1);
          }
        }
        if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      };
      if (hostPath(appMount.Source) !== hostPath(fs.realpathSync(deployment))) fail('App deployment mount does not match this checkout; refusing to back up another configuration');
      const ed = edId();
      if (ed && inspect(ed).State.Running) { resumeBackupEd = true; stopEd(); }
      const worker = workerId();
      if (worker && inspect(worker).State.Running) { resumeBackupWorker = true; stopWorker(); }
      if (app.State.Running) { resumeBackupApp = true; compose(['stop', '-t', '30', 'app']); }
      console.log('Application writers stopped; capturing database, deployment and exchange.');
      const dump = fs.openSync(path.join(work, 'database.dump'), 'wx', 0o600);
      try { compose(['exec', '-T', 'postgres', 'sh', '-c', 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'], { stdio: ['ignore', dump, 'pipe'], timeout: 300_000 }); }
      finally { fs.closeSync(dump); }
      fs.mkdirSync(path.join(work, 'deployment'));
      for (const dir of ['config', 'secrets']) fs.cpSync(safeTarget(`deployment/${dir}`), path.join(work, 'deployment', dir), { recursive: true });
      fs.mkdirSync(path.join(work, 'exchange'));
      run('docker', ['cp', `${appId}:/app/exchange/.`, path.join(work, 'exchange')]);
      const exchangeOwner = JSON.parse(stoppedVolumeCommand(app, 'const s=require("fs").statSync("/app/exchange");console.log(JSON.stringify({uid:s.uid,gid:s.gid}));').toString());
      if (fs.existsSync(safeTarget('public/uploads'))) fs.cpSync(safeTarget('public/uploads'), path.join(work, 'uploads'), { recursive: true });
      const files = tree(work);
      const manifest = { version: 1, createdAt: new Date().toISOString(), database, image: app.Image, exchangeOwner,
        deploymentPermissions: capturePermissions(ROOT, ['deployment/config', 'deployment/secrets']),
        licenseStatus: licenseStatus(work), uploadsPresent: fs.existsSync(path.join(work, 'uploads')), files };
      fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      verifySnapshot(work);
      const out = opts.out ?? path.join(ROOT, 'backups'); fs.mkdirSync(out, { recursive: true, mode: 0o700 });
      const archive = path.join(out, `axima-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.tar.gz`);
      const partial = `${archive}.partial`;
      const fd = fs.openSync(partial, 'wx', 0o600); fs.closeSync(fd);
      run('tar', ['-czf', partial, '-C', work, '.'], { timeout: 300_000 });
      fs.chmodSync(partial, 0o600); fs.renameSync(partial, archive);
      console.log(`Backup written to ${archive}`);
    } else {
      if (process.platform !== 'win32' && process.getuid() !== 0) fail('Restore requires root to preserve recorded deployment ownership');
      inspectArchive(opts.archive);
      run('tar', ['-xzf', opts.archive, '-C', work, '--no-same-owner', '--no-same-permissions']);
      const manifest = verifySnapshot(work); // before any target stop or replacement
      const hasEnvironment = fs.existsSync(envFile);
      if (!hasEnvironment) envFile = path.join(work, 'deployment/secrets/.env');
      appId = serviceId('app');
      const pgId = serviceId('postgres');
      if (pgId) {
        const actual = envOf(inspect(pgId));
        const targetEnv = envFile;
        envFile = path.join(work, 'deployment/secrets/.env');
        const archived = JSON.parse(compose(['config', '--format', 'json']).toString()).services.postgres.environment;
        envFile = targetEnv;
        if (actual.POSTGRES_DB !== manifest.database.name || actual.POSTGRES_USER !== manifest.database.user
          || actual.POSTGRES_PASSWORD !== archived.POSTGRES_PASSWORD) fail('Target PostgreSQL identity or credentials differ from archive; use a fresh isolated target');
      }
      // Stop the selected Compose app before replacing files or touching the database.
      stopEd(); stopWorker();
      if (appId) compose(['stop', '-t', '30', 'app']);
      compose(['up', '-d', '--wait', '--wait-timeout', '60', 'postgres']);
      const dump = fs.openSync(path.join(work, 'database.dump'), 'r');
      try { compose(['exec', '-T', 'postgres', 'sh', '-c', 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges --single-transaction --exit-on-error'], { stdio: [dump, 'pipe', 'pipe'], timeout: 300_000 }); }
      finally { fs.closeSync(dump); }
      const previous = [];
      replaceDirectory(path.join(work, 'deployment/config'), 'deployment/config', previous);
      replaceDirectory(path.join(work, 'deployment/secrets'), 'deployment/secrets', previous);
      restorePermissions(ROOT, manifest.deploymentPermissions);
      // An absent uploads directory means an empty snapshot, not preservation of newer files.
      if (!fs.existsSync(path.join(work, 'uploads'))) fs.mkdirSync(path.join(work, 'uploads'));
      replaceDirectory(path.join(work, 'uploads'), 'public/uploads', previous);
      envFile = path.join(deployment, 'secrets/.env');
      compose(['--profile', 'full', 'create', '--no-build', 'app']);
      appId = serviceId('app'); const app = inspect(appId);
      checkManagedDatabase(app, inspect(serviceId('postgres')));
      stoppedVolumeCommand(app, 'const fs=require("fs"),p="/app/exchange";if(fs.realpathSync(p)!==p)throw Error("unexpected exchange path");for(const name of fs.readdirSync(p))fs.rmSync(p+"/"+name,{recursive:true,force:true});');
      run('docker', ['cp', `${path.join(work, 'exchange')}/.`, `${appId}:/app/exchange`]);
      const owner = manifest.exchangeOwner;
      stoppedVolumeCommand(app, `const fs=require('fs'),path=require('path');function own(p){const s=fs.lstatSync(p);if(s.isSymbolicLink())throw Error('unexpected symlink');fs.chownSync(p,${owner.uid},${owner.gid});if(s.isDirectory())for(const n of fs.readdirSync(p))own(path.join(p,n));}own('/app/exchange');`);
      for (const old of previous) {
        // Paths were generated beside validated, installation-contained targets above.
        if (!path.resolve(old).startsWith(ROOT + path.sep)) fail('Unexpected previous directory');
        fs.rmSync(old, { recursive: true, force: true });
      }
      console.log(`Restore complete; license=${manifest.licenseStatus}. App, worker and ED remain stopped. Verify the selected image, then start and check /api/health before reopening traffic.`);
    }
    failed = false;
  } finally {
    let resumeFailed = false;
    if (resumeBackupApp) {
      try { compose(['start', 'app']); } catch { resumeFailed = true; console.error('Backup cleanup could not restart app; operator action required.'); }
    }
    if (resumeBackupWorker) {
      try { compose(['start', 'worker']); } catch { resumeFailed = true; console.error('Backup cleanup could not restart worker; operator action required.'); }
    }
    if (resumeBackupEd) {
      try { compose(['--profile', 'ed', 'start', 'ed']); } catch { resumeFailed = true; console.error('Backup cleanup could not restart ED; operator action required.'); }
    }
    if (failed) console.error(`Recovery did not complete; private diagnostic snapshot retained at ${work}`);
    else fs.rmSync(work, { recursive: true, force: true });
    operationLock.release();
    if (resumeFailed) process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
}
