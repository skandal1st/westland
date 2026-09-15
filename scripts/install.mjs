import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { generateInstallationIdentity, verifyGrantEnvelope } from '../packages/license-core/index.mjs';

const args = process.argv.slice(2);
const command = args[0];
const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
if (!['plan', 'apply'].includes(command)) {
  console.error('Usage: npm run install:server -- <plan|apply> [--config install.config.json]');
  process.exit(1);
}

const configFile = option('--config');
const config = configFile ? JSON.parse(fs.readFileSync(path.resolve(configFile), 'utf8')) : await collectInteractive();
validateConfig(config);
const outputDir = safeOutputPath(config.outputDir || './deployment');
console.log(JSON.stringify(redactedPlan(config, outputDir), null, 2));
if (command === 'plan') {
  console.log('Plan complete. No files were written and no activation was consumed.');
  process.exit(0);
}

// Resolve every required secret before consuming an activation seat.
const activationKey = requiredSecret(config.license.activationKeyEnv, 'license activation key');
const databaseUrl = requiredSecret(config.database.urlEnv, 'database URL');
const smtpPassword = config.email.enabled ? requiredSecret(config.email.passwordEnv, 'SMTP password') : null;

const configDir = path.join(outputDir, 'config');
const secretsDir = path.join(outputDir, 'secrets');
const privateKeyFile = path.join(secretsDir, 'installation-private-key.pem');
const installationFile = path.join(configDir, 'installation.json');
const grantFile = path.join(configDir, 'license.json');
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(secretsDir, { recursive: true });

let identity;
if (fs.existsSync(privateKeyFile) || fs.existsSync(installationFile)) {
  if (!fs.existsSync(privateKeyFile) || !fs.existsSync(installationFile)) throw new Error('Incomplete installation identity; recover it instead of generating a new one');
  const publicState = JSON.parse(fs.readFileSync(installationFile, 'utf8'));
  identity = { ...publicState, privateKeyPem: fs.readFileSync(privateKeyFile, 'utf8') };
  console.log(`Reusing installation identity ${identity.installationId}.`);
} else {
  identity = generateInstallationIdentity();
  atomicWrite(privateKeyFile, identity.privateKeyPem, 0o600);
  atomicWrite(installationFile, `${JSON.stringify({ schemaVersion: 1, installationId: identity.installationId, publicKeyPem: identity.publicKeyPem, publicKeyThumbprint: identity.publicKeyThumbprint, deploymentClass: config.license.deploymentClass, createdAt: new Date().toISOString() }, null, 2)}\n`, 0o644);
}

const publisherPublicKey = fs.readFileSync(path.resolve(config.license.publisherPublicKeyFile), 'utf8');
const response = await fetch(new URL('/v1/activations', config.license.serverUrl), {
  method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
  body: JSON.stringify({ activationKey, installationId: identity.installationId, installationPublicKeyPem: identity.publicKeyPem, deploymentClass: config.license.deploymentClass, requestedModules: config.modules, release: config.release || 'development' }),
});
const activation = await response.json();
if (!response.ok) throw new Error(`Activation failed (${response.status}): ${activation.error || 'unknown error'}`);
verifyGrantEnvelope(activation.envelope, { [activation.envelope.keyId]: publisherPublicKey }, identity.privateKeyPem);

const runtimeSecrets = [envLine('DATABASE_URL', databaseUrl)];
if (smtpPassword) runtimeSecrets.push(envLine('SMTP_PASSWORD', smtpPassword));
atomicWrite(path.join(secretsDir, 'runtime.env'), `${runtimeSecrets.join('\n')}\n`, 0o600);
atomicWrite(grantFile, `${JSON.stringify(activation.envelope, null, 2)}\n`, 0o644);
// The runtime license guard (src/lib/license) verifies the grant offline, so it
// needs the publisher public key alongside the deployment config.
atomicWrite(path.join(configDir, 'publisher-public.pem'), publisherPublicKey, 0o644);
atomicWrite(path.join(configDir, 'store-profile.json'), `${JSON.stringify(publicProfile(config), null, 2)}\n`, 0o644);
console.log(`Installation configuration written to ${outputDir}.`);
console.log('License signature and installation binding verified locally.');
console.log('Database migration, bootstrap and SMTP delivery tests are the next implementation slice.');

async function collectInteractive() {
  if (!process.stdin.isTTY) throw new Error('Interactive input requires a TTY; use --config');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label, fallback = '') => { const answer = (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim(); return answer || fallback; };
  try {
    const emailEnabled = (await ask('Enable email notifications? (yes/no)', 'yes')).toLowerCase() === 'yes';
    return {
      outputDir: await ask('Deployment state directory', './deployment'),
      store: { code: await ask('Store code', 'westside'), name: await ask('Store name', 'Westside'), baseUrl: await ask('Public URL', 'https://shop.example.com'), timezone: await ask('Timezone', 'Europe/Moscow'), currency: await ask('Currency', 'RUB') },
      admin: { email: await ask('Initial administrator email'), name: await ask('Administrator name', 'Administrator') },
      modules: (await ask('Enabled modules, comma separated', 'commerce-core,commerce-b2b,content,invoices')).split(',').map((item) => item.trim()).filter(Boolean),
      database: { urlEnv: await ask('Environment variable containing DATABASE_URL', 'AXIMA_DATABASE_URL') },
      email: emailEnabled ? { enabled: true, host: await ask('SMTP host'), port: Number(await ask('SMTP port', '587')), secure: (await ask('SMTP TLS immediately? (yes/no)', 'no')).toLowerCase() === 'yes', username: await ask('SMTP username'), passwordEnv: await ask('Environment variable containing SMTP password', 'AXIMA_SMTP_PASSWORD'), fromAddress: await ask('Sender email'), fromName: await ask('Sender name', 'AXIMA Commerce') } : { enabled: false },
      integration: { provider: await ask('Primary ERP provider (one-c/moysklad/custom)', 'one-c') },
      license: { serverUrl: await ask('Licensing server URL', 'http://127.0.0.1:4010'), publisherPublicKeyFile: await ask('Publisher public key file', './publisher-public.pem'), activationKeyEnv: await ask('Environment variable containing activation key', 'AXIMA_ACTIVATION_KEY'), deploymentClass: 'production' },
    };
  } finally { rl.close(); }
}

function validateConfig(value) {
  const required = [value?.store?.code, value?.store?.name, value?.store?.baseUrl, value?.admin?.email, value?.database?.urlEnv, value?.license?.serverUrl, value?.license?.publisherPublicKeyFile, value?.license?.activationKeyEnv];
  if (required.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('Install configuration is incomplete');
  new URL(value.store.baseUrl); new URL(value.license.serverUrl);
  if (!Array.isArray(value.modules) || value.modules.length === 0 || value.modules.some((item) => !/^[a-z0-9-]+$/.test(item))) throw new Error('At least one valid module ID is required');
  if (!['production', 'staging'].includes(value.license.deploymentClass)) throw new Error('Invalid deployment class');
  if (value.email?.enabled && (!value.email.host || !value.email.passwordEnv || !Number.isInteger(value.email.port))) throw new Error('Email configuration is incomplete');
}

function safeOutputPath(candidate) {
  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) throw new Error('Refusing to use a filesystem root or home directory as installation output');
  return resolved;
}
function requiredSecret(name, label) { const value = process.env[name]; if (!value) throw new Error(`Missing ${label} in environment variable ${name}`); return value; }
function envLine(name, value) { if (/\r|\n/.test(value)) throw new Error(`Secret ${name} contains a newline`); return `${name}=${JSON.stringify(value)}`; }
function atomicWrite(file, content, mode) { const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, content, { mode }); fs.renameSync(temporary, file); try { fs.chmodSync(file, mode); } catch {} }
function redactedPlan(value, destination) { return { command, destination, store: value.store, admin: value.admin, modules: value.modules, email: value.email?.enabled ? { ...value.email, password: '[not collected]' } : { enabled: false }, integration: value.integration, license: { serverUrl: value.license.serverUrl, deploymentClass: value.license.deploymentClass, activationKeyEnv: value.license.activationKeyEnv } }; }
function publicProfile(value) { return { schemaVersion: 1, store: value.store, admin: value.admin, modules: [...new Set(value.modules)].sort(), email: value.email?.enabled ? { enabled: true, host: value.email.host, port: value.email.port, secure: value.email.secure, username: value.email.username, fromAddress: value.email.fromAddress, fromName: value.email.fromName } : { enabled: false }, integration: value.integration }; }
