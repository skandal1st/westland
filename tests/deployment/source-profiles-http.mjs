import assert from 'node:assert/strict';
import fs from 'node:fs';

// Reuses the real HTTP fixture, license, authenticated cookies and guarded test DB.
export async function testSourceProfiles(t, { db, store, request, adminCookie, staffCookie, credentialsPath }) {
  await t.test('R05.1 profile API and active source boundaries', async () => {
    const legacy = await db.integrationConnection.create({ data: { storeId: store.id, provider: 'ONE_C', name: 'Z legacy', enabled: true, sourceState: 'ACTIVE', config: { brandGroups: ['preserved'], password: 'private-config-sentinel' } } });
    fs.writeFileSync(credentialsPath, JSON.stringify([{ connectionId: legacy.id, user: 'source-test', pass: 'source-test-secret' }]));
    const api = (route, options = {}) => request(route, { cookie: adminCookie, ...options });
    const path = '/api/staff/integrations';
    const payload = { provider: 'ONE_C', name: 'A production', environment: 'PRODUCTION' };
    assert.equal((await api(path, { method: 'POST', cookie: staffCookie, json: payload })).status, 403);
    assert.equal((await api(`${path}/${legacy.id}`, { method: 'PATCH', cookie: staffCookie, json: { environment: 'TEST' } })).status, 403);
    const created = await api(path, { method: 'POST', json: payload });
    assert.equal(created.status, 201);
    const prepared = await created.json();
    assert.equal(prepared.environment, 'PRODUCTION');
    assert.equal(prepared.sourceState, 'PREPARING');
    assert.equal(prepared.enabled, false);
    assert.equal(prepared.canSync, false);
    for (const json of [{ ...payload, enabled: true }, { ...payload, sourceState: 'ACTIVE' }, { ...payload, config: { password: 'secret' } }, { provider: 'ONE_C', name: 'missing environment' }]) {
      assert.equal((await api(path, { method: 'POST', json })).status, 400);
    }
    assert.equal((await api(`${path}/${legacy.id}`, { method: 'PATCH', json: { environment: 'TEST' } })).status, 200);
    const locked = await api(`${path}/${legacy.id}`, { method: 'PATCH', json: { environment: 'PRODUCTION' } });
    assert.equal(locked.status, 409);
    assert.equal((await locked.json()).error, 'source_environment_locked');
    assert.equal((await api(`${path}/${prepared.id}`, { method: 'PATCH', json: { sourceState: 'ACTIVE' } })).status, 400);
    assert.equal((await api(`${path}/${prepared.id}`, { method: 'PATCH', json: { name: 'Production profile renamed' } })).status, 200);
    const listing = await (await api(path)).json();
    assert.ok(!JSON.stringify(listing).includes('private-config-sentinel'));
    assert.ok(listing.connections.every(row => !('config' in row)));
    assert.equal(listing.connections.find(row => row.id === legacy.id).canSync, true);
    assert.deepEqual((await db.integrationConnection.findUniqueOrThrow({ where: { id: legacy.id } })).config, legacy.config);
    assert.equal((await api(`${path}/${prepared.id}/sync`, { method: 'POST' })).status, 409);
    const job = await db.integrationJob.create({ data: { storeId: store.id, connectionId: prepared.id, type: 'catalog.import', idempotencyKey: prepared.id, status: 'FAILED' } });
    assert.equal((await api(`/api/staff/jobs/${job.id}/retry`, { method: 'POST' })).status, 409);
    assert.equal((await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } })).attempts, 0);
    for (const route of ['warehouses', 'brand-groups', 'status']) {
      const response = await api(`${path}/onec/${route}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.connectionId, legacy.id);
      assert.equal(body.hasConnection, true);
    }
    const exchange = '/api/integrations/1c/exchange?type=catalog&mode=checkauth';
    const headers = { authorization: `Basic ${Buffer.from('source-test:source-test-secret').toString('base64')}` };
    const handshake = await request(exchange, { headers });
    assert.equal(handshake.status, 200);
    assert.match(await handshake.text(), /^success/);
    await db.integrationConnection.update({ where: { id: legacy.id }, data: { enabled: false, sourceState: 'RETIRED' } });
    assert.equal((await request(exchange, { headers })).status, 503);
    for (const route of ['warehouses', 'brand-groups', 'status']) {
      const body = await (await api(`${path}/onec/${route}`)).json();
      assert.equal(body.connectionId, null);
      assert.equal(body.hasConnection, false);
    }
    assert.equal(await db.auditEntry.count({ where: { storeId: store.id, action: { in: ['IntegrationSourceCreated', 'IntegrationSourceProfileUpdated'] } } }), 3);
  });
}
