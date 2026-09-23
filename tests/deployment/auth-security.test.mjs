import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { testSourceProfiles } from './source-profiles-http.mjs';
import { testImportOutcomes } from './import-outcomes-http.mjs';
import { testOnecExchange } from './onec-exchange-http.mjs';
import { assertTestDatabase } from '../../scripts/test-db-guard.mjs';
import { generateInstallationIdentity, signGrant } from '../../packages/license-core/index.mjs';

assertTestDatabase();
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const command = (bin, args) => execFileSync(bin, args, { timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

// Real NextAuth cookies, real handlers and PostgreSQL, with a disposable nginx.
test('R27-R30 real HTTP boundaries', { timeout: 420_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-auth-security-'));
  const db = new PrismaClient();
  const slug = `test-auth-${crypto.randomBytes(6).toString('hex')}`;
  const nginx = `axima-security-${slug}`;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const password = 'local-fixture-password';
  let app, logFd, store, proxy;
  const users = {};
  const sessions = {};
  async function request(route, { cookie = '', json, method = 'GET', headers = {}, origin = base } = {}) {
    return fetch(origin + route, { method, redirect: 'manual', signal: AbortSignal.timeout(45_000), headers: { cookie, ...headers, ...(json === undefined ? {} : { 'content-type': 'application/json' }) }, body: json === undefined ? undefined : JSON.stringify(json) });
  }
  async function login(email, secret = password, origin = base, headers = {}) {
    const csrf = await request('/api/auth/csrf', { origin, headers });
    const csrfToken = (await csrf.json()).csrfToken;
    const cookies = csrf.headers.getSetCookie().map(value => value.split(';')[0]);
    const response = await fetch(origin + '/api/auth/callback/credentials', {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(45_000),
      headers: { ...headers, cookie: cookies.join('; '), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password: secret, csrfToken, json: 'true', callbackUrl: base }),
    });
    const session = response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => value.startsWith('next-auth.session-token='));
    return { response, cookie: session.join('; '), body: await response.json() };
  }
  try {
    store = await db.store.create({ data: { slug, name: 'Security fixture' } });
    await db.appSettings.create({ data: { storeId: store.id } });
    const passwordHash = await bcrypt.hash(password, 4);
    for (const [name, role] of Object.entries({ admin: 'ADMIN', buyer: 'BUYER', staff: 'STAFF', promote: 'BUYER', demote: 'STAFF', throttle: 'BUYER', unaffected: 'BUYER' })) {
      users[name] = await db.user.create({ data: { storeId: store.id, email: `${name}@security.test`, name, role, status: 'ACTIVE', passwordHash } });
    }
    const publisher = crypto.generateKeyPairSync('ed25519');
    const identity = generateInstallationIdentity();
    const envelope = signGrant({ schemaVersion: 1, licenseId: slug, customerId: 'test-only', installationId: identity.installationId,
      installationPublicKeyThumbprint: identity.publicKeyThumbprint, deploymentClass: 'staging', modules: ['commerce-core', 'commerce-b2b', 'content'],
      release: { channel: 'test' }, issuedAt: new Date().toISOString(), runtimeExpiresAt: null }, publisher.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'test');
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify(envelope));
    fs.writeFileSync(path.join(dir, 'private.pem'), identity.privateKeyPem);
    fs.writeFileSync(path.join(dir, 'publisher.pem'), publisher.publicKey.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ store: { code: slug, name: 'Security fixture' }, modules: ['commerce-core', 'commerce-b2b', 'content'], integration: { provider: 'custom' } }));
    logFd = fs.openSync(path.join(dir, 'next.log'), 'w');
    const launchOptions = {
      cwd: repo, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', logFd, logFd],
      env: { ...process.env, NEXTAUTH_SECRET: crypto.randomBytes(32).toString('hex'), NEXTAUTH_URL: base, NEXT_TELEMETRY_DISABLED: '1',
        STORE_PROFILE_PATH: path.join(dir, 'profile.json'), LICENSE_ENFORCE: '1', LICENSE_GRANT_PATH: path.join(dir, 'license.json'),
        LICENSE_INSTALLATION_KEY_PATH: path.join(dir, 'private.pem'), LICENSE_PUBLISHER_PUBLIC_KEY_PATH: path.join(dir, 'publisher.pem'),
        ONEC_SOURCES_FILE: path.join(dir, 'onec-credentials.json'), ONEC_EXCHANGE_DIR: path.join(dir, 'onec') },
    };
    const runWorkerOnce = () => execFileSync(process.execPath, ['dist/integration-worker.cjs', '--once'], { cwd: repo, env: launchOptions.env, windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const finishRun = async (runId) => {
      for (let i = 0; i < 20; i++) {
        runWorkerOnce();
        const run = await db.syncRun.findUniqueOrThrow({ where: { id: runId } });
        if (!['PENDING', 'RUNNING'].includes(run.status)) return run.stats;
        await pause(1_100);
      }
      assert.fail(`Worker did not finish ${runId}`);
    };
    const launch = () => spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-H', '0.0.0.0', '-p', String(port)], launchOptions);
    const waitReady = async () => {
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (app.exitCode !== null) throw new Error(`Next exited; see ${dir}`);
      try { const response = await request('/api/auth/csrf'); if (response.ok) { ready = true; break; } } catch {}
      await pause(300);
    }
    assert.ok(ready, `Next startup timed out; see ${dir}`);
    };
    const restartApp = async () => {
      if (process.platform === 'win32') command('taskkill', ['/PID', String(app.pid), '/T', '/F']);
      else process.kill(-app.pid, 'SIGTERM');
      await pause(500); app = launch(); await waitReady();
    };
    app = launch(); await waitReady();
    for (const name of ['admin', 'buyer', 'staff', 'promote', 'demote']) {
      const result = await login(users[name].email);
      assert.ok(result.cookie, `legitimate ${name} login failed`);
      sessions[name] = result.cookie;
    }
    await t.test('old cookies cannot mutate as suspended buyer/staff or self-reactivate; active admin can reactivate', async () => {
      const body = { variantId: 'nonexistent', quantity: 0 };
      assert.equal((await request('/api/cart/items', { method: 'POST', cookie: sessions.buyer, json: body })).status, 200);
      assert.equal((await request('/api/staff/banners', { cookie: sessions.staff })).status, 200);
      for (const name of ['buyer', 'staff']) {
        assert.equal((await request(`/api/staff/users/${users[name].id}/suspend`, { method: 'POST', cookie: sessions.admin })).status, 200);
        const session = await request('/api/auth/session', { cookie: sessions[name] });
        assert.deepEqual(await session.json(), {});
        assert.ok(session.headers.getSetCookie().some(value => value.includes('next-auth.session-token=;')));
      }
      assert.equal((await request('/api/cart/items', { method: 'POST', cookie: sessions.buyer, json: body })).status, 401);
      assert.equal((await request('/api/staff/banners', { method: 'POST', cookie: sessions.staff, json: { name: 'blocked' } })).status, 401);
      assert.equal((await request(`/api/staff/users/${users.staff.id}/reactivate`, { method: 'POST', cookie: sessions.staff })).status, 401);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: users.staff.id } })).status, 'SUSPENDED');
      assert.equal((await request(`/api/staff/users/${users.staff.id}/reactivate`, { method: 'POST', cookie: sessions.admin })).status, 200);
    });
    await t.test('same cookies reflect promotions/demotions in API, session and staff page middleware', async () => {
      await db.user.update({ where: { id: users.promote.id }, data: { role: 'STAFF' } });
      await db.user.update({ where: { id: users.demote.id }, data: { role: 'BUYER' } });
      assert.equal((await request('/api/staff/banners', { cookie: sessions.promote })).status, 200);
      assert.equal((await request('/api/staff/banners', { cookie: sessions.demote })).status, 403);
      assert.equal((await (await request('/api/auth/session', { cookie: sessions.promote })).json()).user.role, 'STAFF');
      assert.equal((await request('/staff', { cookie: sessions.promote })).status, 200);
      const denied = await request('/staff', { cookie: sessions.demote });
      assert.equal(denied.status, 307);
      assert.ok(denied.headers.get('location') === '/' || denied.headers.get('location') === `${base}/`);
    });
    await t.test('POST/PATCH reject malicious links; safe/empty links persist; historical unsafe links are suppressed', async () => {
      const safe = await request('/api/staff/banners', { method: 'POST', cookie: sessions.admin, json: { name: 'safe', linkUrl: '/catalog?brand=test' } });
      assert.equal(safe.status, 201);
      const { id } = await safe.json();
      for (const linkUrl of ['javascript:alert(1)', 'java\nscript:alert(1)', '\u0000javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '/\\evil.test', '//evil.test']) {
        assert.equal((await request('/api/staff/banners', { method: 'POST', cookie: sessions.admin, json: { name: 'unsafe', linkUrl } })).status, 400);
        assert.equal((await request(`/api/staff/banners/${id}`, { method: 'PATCH', cookie: sessions.admin, json: { linkUrl } })).status, 400);
      }
      assert.equal((await db.siteBanner.findUniqueOrThrow({ where: { id } })).linkUrl, '/catalog?brand=test');
      for (const linkUrl of ['https://example.com/a', '', null]) {
        assert.equal((await request(`/api/staff/banners/${id}`, { method: 'PATCH', cookie: sessions.admin, json: { linkUrl } })).status, 200);
        assert.equal((await db.siteBanner.findUniqueOrThrow({ where: { id } })).linkUrl, linkUrl);
      }
      const old = await db.siteBanner.create({ data: { storeId: store.id, name: 'historical', placement: 'CATALOG', linkUrl: 'javascript:alert(1)' } });
      const { banners } = await (await request('/api/content?placement=CATALOG', { cookie: sessions.admin })).json();
      assert.equal(banners.find(row => row.id === old.id).linkUrl, null);
      assert.equal(await db.siteBanner.count({ where: { storeId: store.id } }), 2);
    });
    await testSourceProfiles(t, { db, store, request, adminCookie: sessions.admin, staffCookie: sessions.promote, credentialsPath: path.join(dir, 'onec-credentials.json') });
    // Use the actual nginx template. The app port is reached via Docker Desktop.
    const configPath = path.join(dir, 'nginx.conf');
    const template = fs.readFileSync(path.join(repo, 'deploy/nginx.conf.template'), 'utf8')
      .replaceAll('__DOMAIN__', 'localhost').replaceAll('127.0.0.1:3000', `host.docker.internal:${port}`);
    fs.writeFileSync(configPath, template);
    command('docker', ['run', '-d', '--name', nginx, '--add-host', 'host.docker.internal:host-gateway', '-p', '127.0.0.1::80', '-v', `${configPath}:/etc/nginx/conf.d/default.conf:ro`, 'nginx:stable-alpine']);
    const binding = JSON.parse(command('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', nginx]));
    proxy = `http://127.0.0.1:${binding['80/tcp'][0].HostPort}`;
    command('docker', ['exec', nginx, 'nginx', '-t']);
    await t.test('real nginx overwrite and legacy append ignore spoofed XFF/X-Real-IP and preserve registration 429', async () => {
      // Distinct registration keys for each phase without sleeping: reset only
      // the app limiter by restarting nginx is deliberately NOT assumed here.
      for (let i = 0; i < 5; i++) {
        assert.equal((await request('/api/auth/register', { origin: proxy, method: 'POST', json: {}, headers: { 'x-forwarded-for': `198.51.100.${i + 1}`, 'x-real-ip': `203.0.113.${i + 1}` } })).status, 400);
      }
      const blocked = await request('/api/auth/register', { origin: proxy, method: 'POST', json: {}, headers: { 'x-forwarded-for': '192.0.2.99', 'x-real-ip': '192.0.2.98' } });
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
      fs.writeFileSync(configPath, template.replace('X-Forwarded-For $remote_addr;', 'X-Forwarded-For $proxy_add_x_forwarded_for;'));
      command('docker', ['exec', nginx, 'nginx', '-t']);
      command('docker', ['exec', nginx, 'nginx', '-s', 'reload']);
      await pause(500);
      for (const prefix of ['1.2.3.4', 'bad, 2.3.4.5']) {
        assert.equal((await request('/api/auth/register', { origin: proxy, method: 'POST', json: {}, headers: { 'x-forwarded-for': prefix } })).status, 429);
      }
    });
    await t.test('real credentials login blocks the sixth account attempt despite XFF rotation; another account still signs in', async () => {
      for (let i = 0; i < 5; i++) {
        const result = await login('  THROTTLE@security.test ', 'wrong', proxy, { 'x-forwarded-for': `198.51.100.${i + 1}` });
        assert.equal(result.cookie, '');
      }
      const blocked = await login(users.throttle.email, password, proxy, { 'x-forwarded-for': '203.0.113.99' });
      assert.equal(blocked.cookie, '');
      assert.match(blocked.body.url, /CredentialsSignin/);
      assert.ok((await login(users.unaffected.email, password, proxy)).cookie);
      // Other trusted peer can still use the same account: no global victim lock.
      assert.ok((await login(users.throttle.email, password, base, { 'x-forwarded-for': '192.0.2.33' })).cookie);
    });
    await t.test('deleted user cannot reuse a signed session cookie', async () => {
      await db.user.delete({ where: { id: users.demote.id } });
      assert.equal((await request('/api/cart', { cookie: sessions.demote })).status, 401);
    });
    await testOnecExchange(t, { db, store, request, base, dir, adminCookie: sessions.admin, staffCookie: sessions.promote, restartApp, finishRun });
    await testImportOutcomes(t, { db, store, request, adminCookie: sessions.admin, runWorkerOnce, finishRun });
  } finally {
    if (app?.pid) {
      try {
        if (process.platform === 'win32') command('taskkill', ['/PID', String(app.pid), '/T', '/F']);
        else process.kill(-app.pid, 'SIGTERM');
      } catch { /* Process may already have exited. */ }
    }
    if (logFd !== undefined) fs.closeSync(logFd);
    try { command('docker', ['rm', '-f', nginx]); } catch { /* Setup may not have created it. */ }
    if (store) {
      await db.providerSnapshot.deleteMany({ where: { storeId: store.id } });
      await db.inbox.deleteMany({ where: { storeId: store.id } });
      await db.integrationError.deleteMany({ where: { storeId: store.id } });
      await db.store.delete({ where: { id: store.id } });
    }
    await db.$disconnect();
    t.diagnostic(`Local fixture logs (test keys only): ${dir}`);
  }
});
