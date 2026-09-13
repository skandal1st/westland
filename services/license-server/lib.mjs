import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { sha256 } from '../../packages/license-core/index.mjs';

export const emptyStore = () => ({ schemaVersion: 1, licenses: [] });

export function readStore(file) {
  if (!fs.existsSync(file)) return emptyStore();
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.schemaVersion !== 1 || !Array.isArray(value.licenses)) throw new Error('Unsupported license store');
  return value;
}

export function writeStore(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function createLicense({ customerId, modules, productionSeats = 1, stagingSeats = 0 }) {
  const activationKey = `axm_${randomBytes(24).toString('base64url')}`;
  return {
    activationKey,
    record: {
      licenseId: `lic_${randomUUID()}`,
      customerId,
      activationKeyHash: sha256(activationKey),
      modules: [...new Set(modules)].sort(),
      seats: { production: productionSeats, staging: stagingSeats },
      release: { channel: 'stable', maxVersion: null, updatesUntil: null },
      activations: [],
      createdAt: new Date().toISOString(),
    },
  };
}

