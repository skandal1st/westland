import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function testOnecExchange(t, { db, store, request, base, dir, adminCookie, staffCookie, restartApp, finishRun }) {
  await t.test('R09-R12 source-bound exchange, mappings, restart and fail-closed sync', async () => {
    const a = await db.integrationConnection.create({ data: { storeId: store.id, provider: 'ONE_C', name: 'Transport A', sourceState: 'ACTIVE', enabled: true, environment: 'TEST' } });
    const b = await db.integrationConnection.create({ data: { storeId: store.id, provider: 'ONE_C', name: 'Transport B', environment: 'TEST' } });
    const credentialsPath = path.join(dir, 'onec-credentials.json');
    let credentials = [{ connectionId: a.id, user: 'a', pass: 'test-a' }, { connectionId: b.id, user: 'b', pass: 'test-b' }];
    const saveCredentials = () => fs.writeFileSync(credentialsPath, JSON.stringify(credentials)); saveCredentials();
    const auth = async (user = 'a', pass = 'test-a') => {
      const response = await request('/api/integrations/1c/exchange?type=catalog&mode=checkauth', { headers: { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` } });
      const lines = (await response.text()).split('\n');
      return { response, cookie: `${lines[1]}=${lines[2]}`, id: lines[2]?.split('.')[1] };
    };
    const exchange = (mode, session, filename, body) => fetch(`${base}/api/integrations/1c/exchange?type=catalog&mode=${mode}${filename ? `&filename=${encodeURIComponent(filename)}` : ''}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { cookie: session.cookie }, body, signal: AbortSignal.timeout(60_000),
    });
    const api = (route, options = {}) => request(`/api/staff/integrations/${a.id}/${route}`, { cookie: adminCookie, ...options });
    assert.equal((await auth('b', 'test-b')).response.status, 503);
    const first = await auth(); assert.equal(first.response.status, 200);
    assert.equal((await exchange('init', first)).status, 200);
    const catalog = Buffer.from('<КоммерческаяИнформация><Каталог><Товары><Товар><Ид>HTTP-P1</Ид><Артикул>HTTP-SKU</Артикул><Наименование>HTTP product</Наименование></Товар></Товары></Каталог></КоммерческаяИнформация>');
    const half = Math.floor(catalog.length / 2);
    assert.equal((await exchange('file', first, 'import.xml', catalog.subarray(0, half))).status, 200);
    const duplicate = await exchange('file', first, 'import.xml', catalog.subarray(0, half));
    assert.equal(duplicate.status, 409); assert.match(await duplicate.text(), /ambiguous_chunk_repeat/);
    assert.equal((await exchange('import', first, 'import.xml')).status, 409);
    await restartApp();
    assert.equal((await exchange('init', first)).status, 200);
    assert.equal((await exchange('file', first, 'import.xml', catalog.subarray(half))).status, 200);
    assert.equal((await exchange('import', first, 'import.xml')).status, 200);
    assert.equal((await exchange('import', first, 'import.xml')).status, 200);
    assert.equal((await exchange('file', first, '../traversal.xml', Buffer.from('x'))).status, 400);
    const offers = '<КоммерческаяИнформация><ПакетПредложений><Предложения><Предложение><Ид>HTTP-P1</Ид><Цены><Цена><ИдТипаЦены>PT</ИдТипаЦены><Валюта>RUB</Валюта><ЦенаЗаЕдиницу>12</ЦенаЗаЕдиницу></Цена></Цены></Предложение></Предложения></ПакетПредложений></КоммерческаяИнформация>';
    const second = await auth(); assert.equal((await exchange('init', second)).status, 200);
    assert.equal((await exchange('file', second, 'offers.xml', Buffer.from(offers))).status, 200);
    assert.equal((await exchange('import', second, 'offers.xml')).status, 200);
    const extra = await auth(); await exchange('init', extra);
    assert.equal((await exchange('file', extra, 'import.xml', Buffer.from('<partial'))).status, 200);
    assert.equal((await api('generations', { method: 'POST', json: { sessionIds: [first.id, extra.id] } })).status, 409);
    const body = { sessionIds: [first.id, second.id] };
    assert.equal((await api('generations', { method: 'POST', cookie: staffCookie, json: body })).status, 403);
    const published = await api('generations', { method: 'POST', json: body }); assert.equal(published.status, 201);
    const generation = await published.json();
    const listing = await (await api('generations')).json();
    assert.ok(!JSON.stringify(listing).includes('credentialDigest'));
    assert.ok(!JSON.stringify(listing).includes('test-a'));
    assert.equal((await exchange('file', first, 'late.xml', Buffer.from('late'))).status, 409);
    // Another ready generation must not silently replace the one selected for sync.
    const newerCatalog = await auth(); await exchange('init', newerCatalog);
    await exchange('file', newerCatalog, 'import.xml', Buffer.from(catalog.toString().replace('HTTP-SKU', 'HTTP-NEW')));
    await exchange('import', newerCatalog, 'import.xml');
    const newerOffers = await auth(); await exchange('init', newerOffers);
    await exchange('file', newerOffers, 'offers.xml', Buffer.from(offers)); await exchange('import', newerOffers, 'offers.xml');
    assert.equal((await api('generations', { method: 'POST', json: { sessionIds: [newerCatalog.id, newerOffers.id] } })).status, 201);
    const book = await db.priceBook.create({ data: { storeId: store.id, code: 'http-r12', name: 'HTTP R12', currency: 'RUB' } });
    assert.equal((await api('mappings', { method: 'POST', cookie: staffCookie, json: { entityType: 'priceType', externalId: 'PT', entityId: book.id } })).status, 403);
    assert.equal((await api('mappings', { method: 'POST', json: { entityType: 'priceType', externalId: 'PT', entityId: book.id } })).status, 200);
    const queued = await api('sync', { method: 'POST', json: { generationId: generation.id } }); assert.equal(queued.status, 202);
    const accepted = await queued.json(); assert.equal(accepted.outcome, 'pending');
    assert.equal((await finishRun(accepted.runId)).outcome, 'success');
    assert.equal((await db.syncCheckpoint.findUniqueOrThrow({ where: { connectionId_entityType: { connectionId: a.id, entityType: 'product' } } })).generationId, generation.id);
    const jobs = await db.integrationJob.findMany({ where: { connectionId: a.id } });
    assert.equal(jobs.length, 3); assert.ok(jobs.every(job => job.generationId === generation.id && job.status === 'SUCCEEDED'));
    assert.equal(await db.priceEntry.count({ where: { priceBookId: book.id, amount: 12, sourceConnectionId: a.id } }), 1);
    assert.equal(await db.productVariant.count({ where: { storeId: store.id, sku: 'HTTP-SKU' } }), 1);
    // The next generation has an invalid currency: HTTP must report failure and stop before stock.
    const bad = await auth(); await exchange('init', bad);
    await exchange('file', bad, 'offers.xml', Buffer.from(offers.replace('<Валюта>RUB</Валюта>', '<Валюта>USD</Валюта>')));
    await exchange('import', bad, 'offers.xml');
    const badPublished = await api('generations', { method: 'POST', json: { sessionIds: [bad.id] } });
    assert.equal(badPublished.status, 201); const badGeneration = await badPublished.json();
    const badSync = await api('sync', { method: 'POST', json: { generationId: badGeneration.id } });
    assert.equal(badSync.status, 202); assert.equal((await finishRun((await badSync.json()).runId)).error, 'price_currency_mismatch');
    assert.equal(await db.integrationJob.count({ where: { connectionId: a.id, generationId: badGeneration.id, type: 'availability.import', status: 'SKIPPED', attempts: 0 } }), 1);
    assert.equal(await db.priceEntry.count({ where: { priceBookId: book.id, amount: 12 } }), 1);
    assert.equal((await api('mappings', { method: 'PUT', cookie: staffCookie, json: {} })).status, 403);
    const large = await auth(); await exchange('init', large);
    assert.equal((await exchange('file', large, 'big.xml', Buffer.alloc(20 * 1024 * 1024 + 1))).status, 413);
    assert.deepEqual((await db.onecExchangeSession.findUniqueOrThrow({ where: { id: large.id } })).files, []);
    await db.integrationConnection.update({ where: { id: a.id }, data: { enabled: false, sourceState: 'RETIRED' } });
    await db.integrationConnection.update({ where: { id: b.id }, data: { enabled: true, sourceState: 'ACTIVE' } });
    assert.equal((await auth()).response.status, 503); // Old Basic credentials never follow the replacement.
    assert.equal((await exchange('file', extra, 'import.xml', Buffer.from('tail'))).status, 401);
    const next = await auth('b', 'test-b'); assert.equal(next.response.status, 200);
    await exchange('init', next);
    assert.equal((await exchange('file', next, 'import.xml', catalog)).status, 200);
    const current = await request(`/api/staff/integrations/onec/status`, { cookie: adminCookie });
    const status = await current.json(); assert.equal(status.connectionId, b.id); assert.equal(status.generationId, null); assert.deepEqual(status.catalog, []);
    credentials = credentials.map(c => c.connectionId === b.id ? { ...c, pass: 'rotated-b' } : c); saveCredentials();
    assert.equal((await exchange('import', next, 'import.xml')).status, 401);
    assert.equal((await auth('b', 'test-b')).response.status, 401);
    assert.equal((await auth('b', 'rotated-b')).response.status, 200);
  });
}
