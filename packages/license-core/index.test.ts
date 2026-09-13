import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  generateInstallationIdentity,
  resolveCapabilities,
  signGrant,
  verifyGrantEnvelope,
} from './index.mjs';

function publisher() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

describe('license core', () => {
  it('verifies a signed grant only for the bound installation', () => {
    const issuer = publisher();
    const installation = generateInstallationIdentity();
    const envelope = signGrant({
      schemaVersion: 1,
      licenseId: 'lic_test',
      customerId: 'customer_test',
      installationId: installation.installationId,
      installationPublicKeyThumbprint: installation.publicKeyThumbprint,
      deploymentClass: 'production',
      modules: ['commerce-core', 'commerce-b2b'],
      release: { channel: 'stable', maxVersion: null, updatesUntil: null },
      issuedAt: new Date().toISOString(),
      runtimeExpiresAt: null,
    }, issuer.privateKey, 'publisher-test');

    expect(verifyGrantEnvelope(envelope, { 'publisher-test': issuer.publicKey }, installation.privateKeyPem).modules).toContain('commerce-core');
    const otherInstallation = generateInstallationIdentity();
    expect(() => verifyGrantEnvelope(envelope, { 'publisher-test': issuer.publicKey }, otherInstallation.privateKeyPem)).toThrow(/another installation/);
  });

  it('rejects tampering and intersects capabilities', () => {
    const issuer = publisher();
    const installation = generateInstallationIdentity();
    const envelope = signGrant({
      schemaVersion: 1,
      licenseId: 'lic_test', customerId: 'customer_test', installationId: installation.installationId,
      installationPublicKeyThumbprint: installation.publicKeyThumbprint,
      deploymentClass: 'production', modules: ['commerce-core'],
      release: { channel: 'stable' }, issuedAt: new Date().toISOString(), runtimeExpiresAt: null,
    }, issuer.privateKey, 'publisher-test');
    envelope.grant.modules.push('unlicensed-module');
    expect(() => verifyGrantEnvelope(envelope, { 'publisher-test': issuer.publicKey }, installation.privateKeyPem)).toThrow(/signature/);
    expect(resolveCapabilities({ installed: ['content', 'commerce-core'], licensed: ['commerce-core'], enabled: ['commerce-core', 'content'] })).toEqual(['commerce-core']);
  });
});

