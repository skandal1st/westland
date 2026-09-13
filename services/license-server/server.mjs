import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { publicKeyThumbprint, sha256, signGrant } from '../../packages/license-core/index.mjs';
import { readStore, writeStore } from './lib.mjs';

const port = Number(process.env.LICENSE_SERVER_PORT || 4010);
const dataFile = path.resolve(process.env.LICENSE_SERVER_DATA_FILE || 'services/license-server/data/licenses.json');
const privateKeyFile = path.resolve(process.env.LICENSE_SERVER_PRIVATE_KEY_FILE || 'services/license-server/keys/publisher-private.pem');
const keyId = process.env.LICENSE_SERVER_KEY_ID || 'publisher-v1';
if (!fs.existsSync(privateKeyFile)) throw new Error(`Missing publisher private key: ${privateKeyFile}`);
const privateKeyPem = fs.readFileSync(privateKeyFile, 'utf8');
let mutationQueue = Promise.resolve();

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validateActivation(body) {
  if (!body || typeof body.activationKey !== 'string' || body.activationKey.length < 20) throw new Error('Invalid activation request');
  if (typeof body.installationId !== 'string' || body.installationId.length > 100) throw new Error('Invalid activation request');
  if (typeof body.installationPublicKeyPem !== 'string' || body.installationPublicKeyPem.length > 4096) throw new Error('Invalid activation request');
  if (!['production', 'staging'].includes(body.deploymentClass)) throw new Error('Invalid deployment class');
  if (!Array.isArray(body.requestedModules) || body.requestedModules.length > 50) throw new Error('Invalid requested modules');
}

async function activate(body) {
  validateActivation(body);
  const task = mutationQueue.then(() => {
    const store = readStore(dataFile);
    const license = store.licenses.find((item) => item.activationKeyHash === sha256(body.activationKey));
    if (!license) throw Object.assign(new Error('Activation rejected'), { status: 403 });
    const requested = [...new Set(body.requestedModules)];
    if (requested.some((moduleId) => !license.modules.includes(moduleId))) throw Object.assign(new Error('Requested module is not licensed'), { status: 403 });
    const thumbprint = publicKeyThumbprint(body.installationPublicKeyPem);
    let activation = license.activations.find((item) => item.installationId === body.installationId && item.publicKeyThumbprint === thumbprint);
    if (!activation) {
      const used = license.activations.filter((item) => item.deploymentClass === body.deploymentClass && !item.deactivatedAt).length;
      const limit = license.seats[body.deploymentClass] || 0;
      if (used >= limit) throw Object.assign(new Error(`No ${body.deploymentClass} activation seats available`), { status: 409 });
      activation = { installationId: body.installationId, publicKeyThumbprint: thumbprint, deploymentClass: body.deploymentClass, activatedAt: new Date().toISOString(), deactivatedAt: null };
      license.activations.push(activation);
      writeStore(dataFile, store);
    }
    const grant = {
      schemaVersion: 1,
      licenseId: license.licenseId,
      customerId: license.customerId,
      installationId: body.installationId,
      installationPublicKeyThumbprint: thumbprint,
      deploymentClass: body.deploymentClass,
      modules: requested.sort(),
      release: license.release,
      issuedAt: new Date().toISOString(),
      runtimeExpiresAt: null,
    };
    return signGrant(grant, privateKeyPem, keyId);
  });
  mutationQueue = task.catch(() => {});
  return task;
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ok: true });
    if (request.method === 'POST' && request.url === '/v1/activations') return json(response, 200, { envelope: await activate(await readJson(request)) });
    return json(response, 404, { error: 'Not found' });
  } catch (error) {
    const status = Number(error.status) || 400;
    return json(response, status, { error: status >= 500 ? 'Internal server error' : error.message });
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, '127.0.0.1', () => console.log(`AXIMA license server listening on http://127.0.0.1:${port}`));
