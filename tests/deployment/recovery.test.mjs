import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateInstallationIdentity, signGrant } from '../../packages/license-core/index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const enabled = process.env.AXIMA_RECOVERY_TEST === '1';
const command = (bin, args, options = {}) => execFileSync(bin, args, { timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'], ...options }).toString();
const sum = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

test('Linux restore preserves key ownership so UID 1001 can read it', {skip: !enabled, timeout: 30_000}, () => {
  const code = `import fs from 'node:fs';import {capturePermissions,restorePermissions} from '/source/scripts/backup-restore.mjs';const base='/tmp/permission-fixture';fs.mkdirSync(base+'/deployment/secrets',{recursive:true});fs.mkdirSync(base+'/deployment/config',{recursive:true});const key=base+'/deployment/secrets/installation-private-key.pem';fs.writeFileSync(key,'fixture');fs.chownSync(base+'/deployment/secrets',1001,1001);fs.chmodSync(base+'/deployment/secrets',0o700);fs.chownSync(key,1001,1001);fs.chmodSync(key,0o600);const m=capturePermissions(base,['deployment/config','deployment/secrets']);fs.chownSync(key,0,0);restorePermissions(base,m);process.setgid(1001);process.setuid(1001);if(fs.readFileSync(key,'utf8')!=='fixture')throw Error('key not readable');console.log('UID 1001 reads restored key');`;
  assert.match(command('docker',['run','--rm','--network','none','-v',`${repo}:/source:ro`,'node:24-alpine','node','--input-type=module','-e',code]),/UID 1001 reads restored key/);
});

test('real PostgreSQL backup/restore: existing + fresh target, integrity failures and unchanged identity', { skip: !enabled, timeout: 300_000 }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-recovery-drill-'));
  const projects = [];
  const step = async (name, fn) => { let passed = false; await t.test(name, async () => { await fn(); passed = true; }); assert.ok(passed, name); };
  const environment = { ...process.env }; delete environment.COMPOSE_PROJECT_NAME; delete environment.COMPOSE_FILE;
  const publisher = crypto.generateKeyPairSync('ed25519');
  const identity = generateInstallationIdentity();
  const grant = signGrant({ schemaVersion: 1, licenseId: 'recovery-fixture', customerId: 'test-only', installationId: identity.installationId,
    installationPublicKeyThumbprint: identity.publicKeyThumbprint, deploymentClass: 'staging', modules: ['commerce-core', 'invoices'],
    release: { channel: 'test' }, issuedAt: new Date().toISOString(), runtimeExpiresAt: null }, publisher.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'recovery-test');
  function fixture(name, withState) {
    const root = path.join(base, name); fs.mkdirSync(root);
    for (const dir of ['scripts', 'packages/license-core']) fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const f of ['scripts/backup-restore.mjs', 'scripts/operation-lock.mjs', 'scripts/license-check.mjs', 'packages/license-core/index.mjs']) fs.copyFileSync(path.join(repo, f), path.join(root, f));
    const nameId = `axima-recovery-drill-${path.basename(base).slice(-8).toLowerCase()}-${name}`;
    const appCode = `import fs from 'node:fs';import http from 'node:http';import {verifyGrantEnvelope} from '/app/packages/license-core/index.mjs';process.on('SIGTERM',()=>process.exit(0));http.createServer((q,r)=>{try{const e=JSON.parse(fs.readFileSync('/app/deployment/config/license.json'));verifyGrantEnvelope(e,{[e.keyId]:fs.readFileSync('/app/deployment/config/publisher-public.pem','utf8')},fs.readFileSync('/app/deployment/secrets/installation-private-key.pem','utf8'));r.end(JSON.stringify({fixture:true,license:'ACTIVE'}));}catch{r.statusCode=500;r.end('INVALID');}}).listen(3000,'0.0.0.0');`;
    fs.writeFileSync(path.join(root, 'docker-compose.yml'), JSON.stringify({ name: nameId, services: {
      postgres: { image: 'postgres:16-alpine', environment: { POSTGRES_USER: '${POSTGRES_USER}', POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}', POSTGRES_DB: '${POSTGRES_DB}' },
        ports: ['127.0.0.1::5432'], volumes: ['db:/var/lib/postgresql/data'], healthcheck: { test: ['CMD-SHELL', 'pg_isready -U axima_test -d axima_commerce_test'], interval: '1s', timeout: '3s', retries: 30 } },
      worker: { image: 'node:24-alpine', user: '1001:1001', volumes: ['exchange:/app/exchange'], profiles: ['full'], command: ['node', '-e', `process.on('SIGTERM',()=>{require('fs').writeFileSync('/app/exchange/worker-stopped','yes');process.exit(0)});setInterval(()=>{},1000)`] },
      app: { image: 'node:24-alpine', user: '1001:1001', environment: { DATABASE_URL: '${DATABASE_URL}' },
        command: ['node', '--input-type=module', '-e', appCode], ports: ['127.0.0.1::3000'],
        volumes: ['./deployment:/app/deployment:ro', './packages:/app/packages:ro', 'exchange:/app/exchange'], profiles: ['full'] }
    }, volumes: { db: {}, exchange: {} } }, null, 2));
    const ctx = { root, nameId };
    ctx.compose = args => command('docker', ['compose', '-p', nameId, '--project-directory', root, '-f', path.join(root, 'docker-compose.yml'), '--env-file', path.join(root, 'deployment/secrets/.env'), ...args], { env: environment });
    ctx.id = service => ctx.compose(['ps', '-aq', service]).trim();
    ctx.sql = sql => ctx.compose(['exec', '-T', 'postgres', 'psql', '-U', 'axima_test', '-d', 'axima_commerce_test', '-v', 'ON_ERROR_STOP=1', '-Atc', sql]).trim();
    ctx.cli = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts/backup-restore.mjs'), ...args], { env: environment, encoding: 'utf8', timeout: 120_000 });
    ctx.running = () => command('docker', ['inspect', '--format', '{{.State.Running}}', ctx.id('app')]).trim() === 'true';
    ctx.workerRunning = () => { const id = ctx.id('worker'); return !!id && command('docker', ['inspect', '--format', '{{.State.Running}}', id]).trim() === 'true'; };
    ctx.health = async () => {
      const port = ctx.compose(['port', 'app', '3000']).trim();
      for (let i=0;i<20;i++) {
        try { const r=await fetch(`http://${port}`, {signal:AbortSignal.timeout(1000)});if(r.ok)return await r.json(); } catch {}
        await new Promise(r=>setTimeout(r,200));
      }
      assert.fail('fixture runtime did not report ACTIVE');
    };
    if (withState) {
      for (const dir of ['deployment/config', 'deployment/secrets', 'public/uploads']) fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, 'deployment/secrets/.env'), 'POSTGRES_USER=axima_test\nPOSTGRES_PASSWORD=axima_test_local_only\nPOSTGRES_DB=axima_commerce_test\nDATABASE_URL=postgresql://axima_test:axima_test_local_only@postgres:5432/axima_commerce_test\n');
      fs.writeFileSync(path.join(root, 'deployment/secrets/installation-private-key.pem'), identity.privateKeyPem);
      fs.writeFileSync(path.join(root, 'deployment/config/license.json'), JSON.stringify(grant));
      fs.writeFileSync(path.join(root, 'deployment/config/publisher-public.pem'), publisher.publicKey.export({type:'spki',format:'pem'}));
      fs.writeFileSync(path.join(root, 'deployment/config/installation.json'), JSON.stringify({installationId:identity.installationId}));
      fs.writeFileSync(path.join(root, 'deployment/config/store-profile.json'), JSON.stringify({store:{code:'recovery-test',name:'Recovery Test'},modules:['commerce-core','invoices'],integration:{provider:'custom'}}));
      fs.writeFileSync(path.join(root, 'public/uploads/probe.txt'), 'upload-before');
    }
    projects.push(ctx);return ctx;
  }
  const source=fixture('existing',true), fresh=fixture('fresh',false);
  try {
    source.compose(['--profile','full','create']);
    command('docker',['run','--rm','--network','none','--volumes-from',source.id('app'),'--user','0','--entrypoint','node','node:24-alpine','-e',"require('fs').chownSync('/app/exchange',1001,1001)"]);
    source.compose(['--profile','full','up','-d','--wait','--wait-timeout','60']);
    source.sql("CREATE TABLE recovery_probe (id int PRIMARY KEY, value text NOT NULL); INSERT INTO recovery_probe VALUES (1, 'before');");
    command('docker',['exec',source.id('app'),'node','-e',"require('fs').writeFileSync('/app/exchange/import.xml','exchange-before')"]);
    assert.equal((await source.health()).license,'ACTIVE');
    const keyHash=sum(path.join(source.root,'deployment/secrets/installation-private-key.pem'));
    let archive;
    await step('backup contains required state and restarts previously running app', () => {
      const r=source.cli('backup','--out',path.join(base,'archives'));
      assert.equal(r.status,0,r.stdout+r.stderr);
      archive=path.join(base,'archives',fs.readdirSync(path.join(base,'archives')).find(n=>n.endsWith('.tar.gz')));
      assert.ok(archive);assert.equal(source.running(),true);assert.equal(source.workerRunning(),true);
      assert.equal(command('docker', ['exec', source.id('worker'), 'cat', '/app/exchange/worker-stopped']).trim(), 'yes');
      const entries=command('tar',['-tzf',archive]);assert.match(entries,/exchange\/import.xml/);assert.match(entries,/manifest.json/);
    });
    await step('missing installation identity fails backup without stopping app', () => {
      const key=path.join(source.root,'deployment/secrets/installation-private-key.pem');fs.renameSync(key,key+'.held');
      try {const r=source.cli('backup');assert.notEqual(r.status,0);assert.match(r.stderr,/Required backup file missing/);assert.equal(source.running(),true);}
      finally {fs.renameSync(key+'.held',key);}
    });
    source.sql("UPDATE recovery_probe SET value='after';");
    fs.writeFileSync(path.join(source.root,'deployment/config/stale.json'),'stale');
    fs.writeFileSync(path.join(source.root,'public/uploads/probe.txt'),'upload-after');
    command('docker',['exec',source.id('app'),'node','-e',"require('fs').writeFileSync('/app/exchange/stale.xml','stale')"]);
    await step('corrupt archive is rejected before writers stop or database changes', () => {
      const dir=path.join(base,'tamper');fs.mkdirSync(dir);command('tar',['-xzf',archive,'-C',dir]);
      fs.writeFileSync(path.join(dir,'exchange/import.xml'),'corrupt');const corrupt=path.join(base,'corrupt.tar.gz');command('tar',['-czf',corrupt,'-C',dir,'.']);
      const r=source.cli('restore','--archive',corrupt,'--confirm');assert.notEqual(r.status,0);assert.match(r.stderr,/checksum mismatch/);
      assert.equal(source.running(),true);assert.equal(source.sql('SELECT value FROM recovery_probe'),'after');
    });
    await step('mismatched target credentials are rejected before any mutation', () => {
      const dir=path.join(base,'different-identity');fs.mkdirSync(dir);command('tar',['-xzf',archive,'-C',dir]);
      const f=path.join(dir,'deployment/secrets/.env');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replaceAll('axima_test_local_only','different-test-only-password'));
      const m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));m.files['deployment/secrets/.env']=sum(f);fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(m));
      const mismatch=path.join(base,'mismatch.tar.gz');command('tar',['-czf',mismatch,'-C',dir,'.']);
      const r=source.cli('restore','--archive',mismatch,'--confirm');assert.notEqual(r.status,0);assert.match(r.stderr,/identity or credentials differ/);
      assert.equal(source.running(),true);assert.equal(source.sql('SELECT value FROM recovery_probe'),'after');
    });
    await step('existing target: replaces contents, restores database/volume/uploads and stops app', async () => {
      const r=source.cli('restore','--archive',archive,'--confirm');assert.equal(r.status,0,r.stdout+r.stderr);
      assert.equal(source.running(),false);assert.equal(source.workerRunning(),false);assert.equal(source.sql('SELECT value FROM recovery_probe'),'before');
      assert.equal(fs.existsSync(path.join(source.root,'deployment/config/config')),false);
      assert.equal(fs.existsSync(path.join(source.root,'deployment/config/stale.json')),false);
      assert.equal(fs.readFileSync(path.join(source.root,'public/uploads/probe.txt'),'utf8'),'upload-before');
      assert.equal(sum(path.join(source.root,'deployment/secrets/installation-private-key.pem')),keyHash);
      source.compose(['--profile','full','up','-d','app']);assert.equal((await source.health()).license,'ACTIVE');
      const files=command('docker',['exec',source.id('app'),'node','-e',"console.log(require('fs').readdirSync('/app/exchange').join(','));console.log(require('fs').readFileSync('/app/exchange/import.xml','utf8')); "]);
      assert.match(files,/exchange-before/);assert.doesNotMatch(files,/stale.xml|exchange,/);
    });
    await step('fresh target: same data and identity without a new activation', async () => {
      const r=fresh.cli('restore','--archive',archive,'--confirm');assert.equal(r.status,0,r.stdout+r.stderr);
      assert.equal(fresh.sql('SELECT value FROM recovery_probe'),'before');assert.equal(fresh.running(),false);
      assert.equal(sum(path.join(fresh.root,'deployment/secrets/installation-private-key.pem')),keyHash);
      fresh.compose(['--profile','full','up','-d','app']);assert.equal((await fresh.health()).license,'ACTIVE');
    });
    await step('pg_restore failure keeps app stopped and existing database intact', () => {
      const dir=path.join(base,'bad-dump');fs.mkdirSync(dir);command('tar',['-xzf',archive,'-C',dir]);
      fs.writeFileSync(path.join(dir,'database.dump'),'invalid dump');
      const m=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));m.files['database.dump']=sum(path.join(dir,'database.dump'));fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(m));
      const invalid=path.join(base,'bad-dump.tar.gz');command('tar',['-czf',invalid,'-C',dir,'.']);
      source.sql("UPDATE recovery_probe SET value='keep-on-failure';");
      const r=source.cli('restore','--archive',invalid,'--confirm');assert.notEqual(r.status,0);
      assert.equal(source.running(),false);assert.equal(source.workerRunning(),false);assert.equal(source.sql('SELECT value FROM recovery_probe'),'keep-on-failure');
    });
    console.log('Recovery fixture evidence:', JSON.stringify({existing:true,fresh:true,identityPreserved:true,runtimeLicense:'ACTIVE',database:'PostgreSQL 16',app:'test fixture using real license-core; full Next release acceptance remains R39'}));
  } finally {
    for (const c of projects) {
      if (c.nameId.startsWith('axima-recovery-drill-') && fs.existsSync(path.join(c.root,'deployment/secrets/.env'))) {
        try {c.compose(['--profile','full','down','--volumes','--remove-orphans']);}catch {console.error('Fixture cleanup failed for',c.nameId);}
      }
    }
    // Keep private fixture files on test failure for diagnosis; never copy their keys into the repo.
    console.log('Private recovery fixture directory:',base);
  }
});
