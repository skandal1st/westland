// Standalone license status probe for the acceptance simulation / ops.
// Mirrors src/lib/license/runtime.ts::computeLicenseState but with no TS/alias
// deps so it can run from a plain node invocation in any environment.
//
// Usage: node scripts/license-check.mjs <grant.json> <installation-key.pem> <publisher-pub.pem> [EXPECTED]
// Prints the status; exits non-zero if EXPECTED is given and does not match.
import fs from 'node:fs';
import { createPublicKey, createPrivateKey } from 'node:crypto';
import { verifyGrantEnvelope, publicKeyThumbprint } from '../packages/license-core/index.mjs';

const [grantPath, keyPath, pubPath, expected] = process.argv.slice(2);

function computeLicenseState() {
  if (!grantPath || !fs.existsSync(grantPath)) return { status: 'ABSENT', reason: 'no grant' };
  try {
    const envelope = JSON.parse(fs.readFileSync(grantPath, 'utf8'));
    const priv = fs.readFileSync(keyPath, 'utf8');
    const pub = fs.readFileSync(pubPath, 'utf8');
    const grant = verifyGrantEnvelope(envelope, { [envelope.keyId]: pub }, priv);
    const local = publicKeyThumbprint(createPublicKey(createPrivateKey(priv)).export({ type: 'spki', format: 'pem' }).toString());
    if (local !== grant.installationPublicKeyThumbprint) return { status: 'INVALID', reason: 'installation identity mismatch' };
    return { status: 'ACTIVE' };
  } catch (error) {
    return { status: 'INVALID', reason: error.message };
  }
}

const state = computeLicenseState();
console.log(`license status = ${state.status}${state.reason ? ` (${state.reason})` : ''}`);
if (expected && state.status !== expected) process.exit(1);
