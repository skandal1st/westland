import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { assertTestDatabase } from '../../scripts/test-db-guard.mjs';
import { generateInstallationIdentity, signGrant } from '../../packages/license-core/index.mjs';
assertTestDatabase();
const image = process.env.AXIMA_WORKER_IMAGE;
test('release image: queued chain, installation scope, license guard and graceful SIGTERM', { skip: !image, timeout: 120_000 }, async () => {
  const db = new PrismaClient(), id = crypto.randomUUID(), name = `axima-r15-${id}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-r15-image-'));
  let store, foreign;
  const docker = args => execFileSync('docker', args, { windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  try {
    store = await db.store.create({ data: { slug: `test-image-${id}`, name: 'R15 image' } });
    foreign = await db.store.create({ data: { slug: `test-foreign-${id}`, name: 'Foreign' } });
    const connection = await db.integrationConnection.create({ data: { storeId: store.id, name: 'Image', provider: 'CUSTOM', sourceState: 'ACTIVE', enabled: true, environment: 'TEST', config: { fixtures: [{ externalId: 'image', sku: 'IMAGE', name: 'Image' }] } } });
    const other = await db.integrationConnection.create({ data: { storeId: foreign.id, name: 'Other', provider: 'CUSTOM', sourceState: 'ACTIVE', enabled: true, environment: 'TEST' } });
    const ignored = await db.integrationJob.create({ data: { storeId: foreign.id, connectionId: other.id, type: 'catalog.import', idempotencyKey: id + ':foreign' } });
    const run = await db.syncRun.create({ data: { connectionId: connection.id, entityType: 'commerce.sync', queued: true } });
    const results = []; let dependsOnId;
    for (const type of ['catalog.import', 'prices.import', 'availability.import']) {
      const job = await db.integrationJob.create({ data: { storeId: store.id, connectionId: connection.id, syncRunId: run.id, type, dependsOnId, idempotencyKey: id + type } });
      results.push({ type, jobId: job.id, status: 'pending' }); dependsOnId = job.id;
    }
    await db.syncRun.update({ where: { id: run.id }, data: { stats: { runId: run.id, generationId: null, outcome: 'pending', results } } });
    const identity = generateInstallationIdentity(), publisher = crypto.generateKeyPairSync('ed25519');
    const grant = signGrant({ schemaVersion: 1, licenseId: 'r15-image', customerId: 'fixture', installationId: identity.installationId,
      installationPublicKeyThumbprint: identity.publicKeyThumbprint, deploymentClass: 'staging', modules: ['commerce-core'], release: { channel: 'test' }, issuedAt: new Date().toISOString(), runtimeExpiresAt: null }, publisher.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'r15');
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify(grant));
    fs.writeFileSync(path.join(dir, 'private.pem'), identity.privateKeyPem);
    fs.writeFileSync(path.join(dir, 'publisher.pem'), publisher.publicKey.export({ type: 'spki', format: 'pem' }));
    fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({ store: { code: store.slug, name: 'R15' }, modules: ['commerce-core'], integration: { provider: 'custom' } }));
    const url = new URL(process.env.DATABASE_URL); url.hostname = 'host.docker.internal';
    const args = ['-v', `${dir}:/fixture:ro`, '-e', `DATABASE_URL=${url}`, '-e', 'LICENSE_ENFORCE=1', '-e', 'STORE_PROFILE_PATH=/fixture/profile.json', '-e', 'LICENSE_GRANT_PATH=/fixture/license.json', '-e', 'LICENSE_INSTALLATION_KEY_PATH=/fixture/private.pem', '-e', 'LICENSE_PUBLISHER_PUBLIC_KEY_PATH=/fixture/publisher.pem', '-e', 'INTEGRATION_WORKER_INTERVAL_MS=250'];
    for (let i = 0; i < 3; i++) assert.match(docker(['run', '--rm', ...args, image, 'node', 'dist/integration-worker.cjs', '--once']), /integration_worker_tick/);
    assert.equal((await db.syncRun.findUniqueOrThrow({ where: { id: run.id } })).status, 'SUCCEEDED');
    assert.equal(await db.productVariant.count({ where: { storeId: store.id, sku: 'IMAGE' } }), 1);
    assert.equal((await db.integrationJob.findUniqueOrThrow({ where: { id: ignored.id } })).attempts, 0);
    docker(['run', '--rm', ...args, image, 'node', 'dist/integration-worker.cjs', '--health']);
    const blocked = await db.integrationJob.create({ data: { storeId: store.id, connectionId: connection.id, type: 'catalog.import', idempotencyKey: id + ':blocked', availableAt: new Date(0) } });
    const denied = spawnSync('docker', ['run', '--rm', ...args, '-e', 'LICENSE_GRANT_PATH=/fixture/missing.json', image, 'node', 'dist/integration-worker.cjs', '--once'], { windowsHide: true, encoding: 'utf8', timeout: 60_000 });
    assert.equal(denied.status, 1); assert.match(denied.stderr, /license_absent/);
    assert.equal((await db.integrationJob.findUniqueOrThrow({ where: { id: blocked.id } })).attempts, 0);
    const before = (await db.integrationWorker.findUniqueOrThrow({ where: { storeId: store.id } })).lastFinishedAt;
    docker(['run', '-d', '--name', name, ...args, image, 'node', 'dist/integration-worker.cjs']);
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const now = (await db.integrationWorker.findUniqueOrThrow({ where: { storeId: store.id } })).lastFinishedAt;
      if (now > before) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(ready); docker(['stop', '-t', '10', name]);
    assert.equal(docker(['inspect', '--format', '{{.State.ExitCode}}', name]), '0');
    console.log('Image worker PASS: generation-independent CUSTOM chain, store isolation, license refusal, health, graceful SIGTERM.');
  } finally {
    try { docker(['rm', '-f', name]); } catch { /* Not started or already removed. */ }
    for (const row of [store, foreign].filter(Boolean)) {
      await db.inbox.deleteMany({ where: { storeId: row.id } }); await db.integrationError.deleteMany({ where: { storeId: row.id } }); await db.providerSnapshot.deleteMany({ where: { storeId: row.id } }); await db.store.delete({ where: { id: row.id } });
    }
    await db.$disconnect();
  }
});
