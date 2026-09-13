export type DeploymentClass = 'production' | 'staging';
export type LicenseGrant = {
  schemaVersion: 1;
  licenseId: string;
  customerId: string;
  installationId: string;
  installationPublicKeyThumbprint: string;
  deploymentClass: DeploymentClass;
  modules: string[];
  release: { channel: string; maxVersion?: string | null; updatesUntil?: string | null };
  issuedAt: string;
  runtimeExpiresAt: string | null;
};
export type LicenseEnvelope = { schemaVersion: 1; algorithm: 'Ed25519'; keyId: string; grant: LicenseGrant; signature: string };
export function canonicalize(value: unknown): string;
export function sha256(value: string | Buffer): string;
export function publicKeyThumbprint(publicKeyPem: string): string;
export function generateInstallationIdentity(): { installationId: string; privateKeyPem: string; publicKeyPem: string; publicKeyThumbprint: string };
export function signGrant(grant: LicenseGrant, privateKeyPem: string, keyId: string): LicenseEnvelope;
export function verifyGrantEnvelope(envelope: LicenseEnvelope, publisherPublicKeys: Record<string, string>, installationPrivateKeyPem: string, now?: Date): LicenseGrant;
export function resolveCapabilities(input: { installed: string[]; licensed: string[]; enabled: string[] }): string[];
export function validateGrant(grant: unknown): void;

