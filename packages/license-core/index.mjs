import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';

export const LICENSE_SCHEMA_VERSION = 1;
export const LICENSE_ALGORITHM = 'Ed25519';

export function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new TypeError('License payload contains a non-JSON value');
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function publicKeyThumbprint(publicKeyPem) {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `sha256:${sha256(der)}`;
}

export function generateInstallationIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    installationId: randomUUID(),
    privateKeyPem,
    publicKeyPem,
    publicKeyThumbprint: publicKeyThumbprint(publicKeyPem),
  };
}

export function signGrant(grant, privateKeyPem, keyId) {
  validateGrant(grant);
  if (!keyId || typeof keyId !== 'string') throw new Error('Signing keyId is required');
  const payload = Buffer.from(canonicalize(grant));
  const signature = sign(null, payload, createPrivateKey(privateKeyPem)).toString('base64url');
  return {
    schemaVersion: LICENSE_SCHEMA_VERSION,
    algorithm: LICENSE_ALGORITHM,
    keyId,
    grant,
    signature,
  };
}

export function verifyGrantEnvelope(envelope, publisherPublicKeys, installationPrivateKeyPem, now = new Date()) {
  if (!envelope || envelope.schemaVersion !== LICENSE_SCHEMA_VERSION) throw new Error('Unsupported license envelope version');
  if (envelope.algorithm !== LICENSE_ALGORITHM) throw new Error('Unsupported license signature algorithm');
  const publisherKey = publisherPublicKeys[envelope.keyId];
  if (!publisherKey) throw new Error(`Unknown publisher key: ${envelope.keyId}`);
  validateGrant(envelope.grant);
  const valid = verify(
    null,
    Buffer.from(canonicalize(envelope.grant)),
    createPublicKey(publisherKey),
    Buffer.from(envelope.signature, 'base64url'),
  );
  if (!valid) throw new Error('Invalid license signature');

  const localPublicKey = createPublicKey(createPrivateKey(installationPrivateKeyPem)).export({ type: 'spki', format: 'pem' }).toString();
  const localThumbprint = publicKeyThumbprint(localPublicKey);
  if (localThumbprint !== envelope.grant.installationPublicKeyThumbprint) {
    throw new Error('License belongs to another installation identity');
  }

  if (envelope.grant.runtimeExpiresAt && now > new Date(envelope.grant.runtimeExpiresAt)) {
    throw new Error('License runtime entitlement has expired');
  }
  return envelope.grant;
}

export function resolveCapabilities({ installed, licensed, enabled }) {
  const licensedSet = new Set(licensed);
  const enabledSet = new Set(enabled);
  return [...new Set(installed)].filter((moduleId) => licensedSet.has(moduleId) && enabledSet.has(moduleId)).sort();
}

export function validateGrant(grant) {
  const strings = ['licenseId', 'customerId', 'installationId', 'installationPublicKeyThumbprint', 'deploymentClass', 'issuedAt'];
  if (!grant || grant.schemaVersion !== LICENSE_SCHEMA_VERSION) throw new Error('Unsupported license grant version');
  for (const field of strings) if (typeof grant[field] !== 'string' || !grant[field]) throw new Error(`Invalid grant field: ${field}`);
  if (!['production', 'staging'].includes(grant.deploymentClass)) throw new Error('Invalid deployment class');
  if (!Array.isArray(grant.modules) || grant.modules.some((item) => typeof item !== 'string' || !item)) throw new Error('Invalid licensed modules');
  if (!grant.release || typeof grant.release !== 'object' || typeof grant.release.channel !== 'string') throw new Error('Invalid release entitlement');
  if (Number.isNaN(Date.parse(grant.issuedAt))) throw new Error('Invalid grant issue date');
  if (grant.runtimeExpiresAt !== null && grant.runtimeExpiresAt !== undefined && Number.isNaN(Date.parse(grant.runtimeExpiresAt))) throw new Error('Invalid runtime expiry');
}

