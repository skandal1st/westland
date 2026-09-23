import assert from 'node:assert/strict';
export async function testImportOutcomes(t, { db, store, request, adminCookie, runWorkerOnce, finishRun }) {
  await t.test('R13 HTTP persists partial/failed reports and retries only the selected job', async () => {
    await db.integrationConnection.updateMany({ where: { storeId: store.id, sourceState: 'ACTIVE' }, data: { sourceState: 'RETIRED', enabled: false } });
    const good = { externalId: 'r13-ok', sku: 'R13-OK', name: 'R13 good' }, bad = { externalId: 'r13-bad', sku: 'R13-BAD' };
    const connection = await db.integrationConnection.create({ data: { storeId: store.id, name: 'R13 HTTP', provider: 'CUSTOM', sourceState: 'ACTIVE', enabled: true, environment: 'TEST', config: { fixtures: [good, bad], pageSize: 1 } } });
    const api = (route, opts = {}) => request(`/api/staff/integrations/${connection.id}/${route}`, { cookie: adminCookie, ...opts });
    const response = await api('sync', { method: 'POST' }); assert.equal(response.status, 202);
    const queued = await response.json(); assert.equal(queued.outcome, 'pending');
    assert.ok(queued.jobId); assert.equal(await db.integrationAttempt.count({ where: { job: { syncRunId: queued.runId } } }), 0);
    const repeated = await api('sync', { method: 'POST' }); assert.equal(repeated.status, 202); assert.equal((await repeated.json()).runId, queued.runId);
    const report = await finishRun(queued.runId); assert.equal(report.outcome, 'partial'); assert.equal(report.results.length, 3);
    assert.deepEqual(report.results.map(r => r.status), ['partial', 'skipped', 'skipped']);
    assert.equal(report.results[0].stats.failed, 1); assert.equal(report.results[0].issues[0].externalId, bad.externalId);
    const listing = await (await request('/api/staff/integrations', { cookie: adminCookie })).json();
    assert.deepEqual(listing.connections.find(c => c.id === connection.id).lastRun.stats, report);
    const jobs = await (await api('jobs')).json(); const catalogJob = jobs.jobs.find(j => j.type === 'catalog.import'); assert.equal(catalogJob.status, 'PARTIAL'); assert.equal(catalogJob.latestAttempt.stats.outcome, 'partial');
    // A due job from a different source must remain untouched by manual retry.
    const unrelated = await db.integrationJob.create({ data: { storeId: store.id, connectionId: connection.id, type: 'availability.import', idempotencyKey: `r13-unrelated-${connection.id}`, availableAt: new Date(Date.now() + 3_600_000) } });
    await db.integrationConnection.update({ where: { id: connection.id }, data: { config: { fixtures: [good, { ...bad, name: 'Fixed' }], pageSize: 1 } } });
    const retry = await request(`/api/staff/jobs/${report.results[0].jobId}/retry`, { cookie: adminCookie, method: 'POST' });
    assert.equal(retry.status, 202); assert.equal((await retry.json()).queued, true);
    assert.equal((await db.integrationJob.findUniqueOrThrow({ where: { id: report.results[0].jobId } })).status, 'PENDING');
    runWorkerOnce(); assert.equal((await db.integrationJob.findUniqueOrThrow({ where: { id: report.results[0].jobId } })).status, 'SUCCEEDED');
    assert.equal((await db.integrationJob.findUniqueOrThrow({ where: { id: unrelated.id } })).status, 'PENDING');
    assert.equal((await db.syncRun.findUniqueOrThrow({ where: { id: report.runId } })).status, 'PARTIAL');
    await db.integrationJob.update({ where: { id: unrelated.id }, data: { status: 'SKIPPED' } });
    await db.integrationConnection.update({ where: { id: connection.id }, data: { config: { fixtures: [{ externalId: 'r13-bad2' }] } } });
    const allBad = await api('sync', { method: 'POST' }); assert.equal(allBad.status, 202);
    const failed = await finishRun((await allBad.json()).runId); assert.equal(failed.outcome, 'failed'); assert.equal(failed.results[0].stats.imported, 0);
    const badRetry = await request(`/api/staff/jobs/${failed.results[0].jobId}/retry`, { cookie: adminCookie, method: 'POST' });
    assert.equal(badRetry.status, 202); runWorkerOnce();
    assert.equal((await db.integrationJob.findUniqueOrThrow({ where: { id: failed.results[0].jobId } })).status, 'FAILED');
    const persisted = await request(`/api/staff/integrations/${connection.id}/runs/${failed.runId}`, { cookie: adminCookie });
    assert.equal(persisted.status, 200); assert.equal((await persisted.json()).stats.outcome, 'failed');
  });
  await t.test('R14 HTTP refuses retry of a leased RUNNING job without resetting its owner', async () => {
    const connection = await db.integrationConnection.findFirstOrThrow({ where: { storeId: store.id, sourceState: 'ACTIVE' } });
    const job = await db.integrationJob.create({ data: { storeId: store.id, connectionId: connection.id, type: 'catalog.import', idempotencyKey: `r14-live-${connection.id}`, status: 'RUNNING', attempts: 1, leaseToken: 'fixture-owner', leaseExpiresAt: new Date(Date.now() + 60_000) } });
    const response = await request(`/api/staff/jobs/${job.id}/retry`, { cookie: adminCookie, method: 'POST' });
    assert.equal(response.status, 409); assert.equal((await response.json()).error, 'job_running');
    const saved = await db.integrationJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(saved.status, 'RUNNING'); assert.equal(saved.attempts, 1); assert.equal(saved.leaseToken, 'fixture-owner');
    const detail = await (await request(`/api/staff/jobs/${job.id}`, { cookie: adminCookie })).json();
    assert.ok(detail.job.leaseExpiresAt); assert.equal('leaseToken' in detail.job, false);
  });

}
